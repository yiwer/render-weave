/**
 * `renderweave mcp` 的工具（第三阶段 PRD 第 5、6 条）：读取、校验、草稿预览、元素检查、局部放大、资源列表、DSL 参考与交回前核对成果。
 * 全部只读（M53）：不写工作区、资源仓库或工作目录，也没有发布、删除与正式出图的途径。
 * 工作区是服务启动时读入的快照；工作目录内的文件按路径读取（files.ts），资源仓库只按 res:资源ID 经资源仓库接口读取。工作副本只在本次调用的内存中代替已保存模板（M49、M50）。
 * 工具名称、输入 Schema 与输出结构是 v0.5 的稳定合同，由快照测试守护：新增工具或可选参数属于兼容改动，改名或删参数要升合同版本。
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import type { CanvasKit } from 'canvaskit-wasm';
import { checkAgentOutcome, type OutcomeTarget } from '../agent/outcome.js';
import { loadCanvasKit } from '../canvaskit.js';
import { CompiledSchemaError, validateDataset } from '../dataset-validation.js';
import { loadResourceImage, type LoadedImage } from '../images.js';
import type { LayoutNode } from '../layout/index.js';
import { ProblemCodes, severe, type Problem } from '../problems.js';
import { render } from '../render.js';
import { parseResourceRef } from '../resources.js';
import { mmToPx } from '../units.js';
import { findStaticSchema } from '../schema/builtins.js';
import { publishStaticSchema } from '../schema/publish.js';
import { rasterizeSvg, SvgLoader } from '../svg.js';
import { parseTemplate } from '../template/parse.js';
import { prepareTemplates } from '../template/program.js';
import { DEFAULT_FALLBACK_FONTS } from '../text/fonts.js';
import { isRecord } from '../util.js';
import { formatStaticSchemaRef, parseDatasetDocument, parseStaticSchemaRef, type StaticSchemaEntry, type TemplateEntry, type Workspace } from '../workspace.js';
import { ToolInputError, type WorkingDirectory } from './files.js';
import type { ContentBlock, McpTool, ToolResult } from './server.js';

/** 工具合同版本，也是 initialize 返回的服务版本。 */
export const MCP_CONTRACT_VERSION = '0.5.0';

/** 草稿预览的 DPI 上限，以及图片最长边的像素上限：超出时降低 DPI。 */
export const DRAFT_MAX_DPI = 300;
export const DRAFT_MAX_SIDE_PX = 2000;
/** 局部预览先按提高后的 DPI 出整图再裁切，整图像素数以此为限。 */
const DRAFT_REGION_MAX_TOTAL_PX = 40_000_000;
/** 局部放大的输出最长边与最大倍数。 */
const VIEW_MAX_SIDE_PX = 1400;
const VIEW_MAX_SCALE = 4;
/** SVG 资源整图栅格化的单边与像素总数上限。 */
const VIEW_SVG_MAX_SIDE_PX = 8000;
const VIEW_SVG_MAX_TOTAL_PX = 16_000_000;
/** 元素检查一次最多返回的元素数。 */
const INSPECT_MAX_NODES = 300;

export interface ToolContext {
  readonly workingDirectory: WorkingDirectory;
  /** 启动时读入的工作区快照。 */
  readonly workspace: Workspace;
  readonly workspaceDir: string;
  readonly resourcesDir: string;
  /** 本轮任务与已知输入（--outcome-context）；没有时 check_outcome 报工具错误。 */
  readonly outcome?: OutcomeTarget;
}

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const REFERENCE_FILES = {
  'reference/data-definition': 'agent/reference/data-definition.md',
  'reference/template': 'agent/reference/template.md',
  'schema/data-definition': 'schemas/data-definition.schema.json',
  'schema/dataset': 'schemas/dataset.schema.json',
  'schema/template': 'schemas/template.schema.json',
  'schema/render-request': 'schemas/render-request.schema.json',
  'schema/batch-request': 'schemas/batch-request.schema.json',
} as const;

const paths = (description: string) => ({ type: 'array', minItems: 1, items: { type: 'string', minLength: 1 }, description });
const DRAFT_INPUT = {
  request: { type: 'object', description: '渲染请求：template、dataset（{"id": 数据集ID} 或 {"inline": 数据集文档}）、parameters、output（width、height 毫米，dpi 可省略）' },
  templates: paths('工作目录内的模板文件，作为工作副本代替同名的已保存模板，或作为新模板加入'),
  datasetPath: { type: 'string', minLength: 1, description: '工作目录内的数据集文件，代替 request.dataset；两者只写一个' },
};

export function createTools(context: ToolContext): McpTool[] {
  const { workingDirectory: files, workspace } = context;
  const shown = (problems: readonly Problem[]) => problems.map((problem) => displayProblem(problem, context));

  const tools: McpTool[] = [
    {
      name: 'list_documents',
      description: '列出工作区快照中的文档：已发布的静态数据定义（名称、版本、有无编译产物）、模板（名称与基准）、数据集（ID 与所选静态数据定义），以及读取工作区时发现的问题。' +
        '快照在服务启动时读入，之后不变；不含内置数据定义（空数据定义、单值·文本等）。',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      async call() {
        return json({
          definitions: workspace.staticSchemas.map((entry) => ({ ...entry.ref, displayName: displayName(entry), definition: entry.definition !== undefined, compiled: entry.compiled !== undefined })),
          templates: workspace.templates.map((entry) => ({ name: entry.name, base: isRecord(entry.document) ? parseStaticSchemaRef(entry.document['base']) ?? null : null })),
          datasets: workspace.datasets.map((entry) => ({ id: entry.id, staticSchema: entry.document.dataset.staticSchema })),
          problems: shown(workspace.problems),
        }, { documents: workspace.staticSchemas.length + workspace.templates.length + workspace.datasets.length });
      },
    },
    {
      name: 'read_document',
      description: '读取工作区快照中的一份文档，返回 JSON 原文。kind 取 definition（静态数据定义 DSL）、compiled（编译产物 JSON Schema，内置数据定义也能读）、template（模板）或 dataset（数据集）；' +
        'definition 与 compiled 写 name 与 version，template 写 name，dataset 写 id。',
      inputSchema: { type: 'object', additionalProperties: false, required: ['kind'], properties: {
        kind: { enum: ['definition', 'compiled', 'template', 'dataset'] },
        name: { type: 'string', minLength: 1, description: '静态数据定义或模板的名称' },
        version: { type: 'integer', minimum: 1, description: '静态数据定义的版本' },
        id: { type: 'string', minLength: 1, description: '数据集 ID' },
      } },
      async call(args) {
        const kind = args['kind'] as string, name = args['name'] as string | undefined, version = args['version'] as number | undefined, id = args['id'] as string | undefined;
        const document = (() => {
          if (kind === 'template') {
            if (name === undefined) throw new ToolInputError('kind 为 template 时要写 name');
            return workspace.templates.find((entry) => entry.name === name)?.document;
          }
          if (kind === 'dataset') {
            if (id === undefined) throw new ToolInputError('kind 为 dataset 时要写 id');
            return workspace.datasets.find((entry) => entry.id === id)?.document;
          }
          if (name === undefined || version === undefined) throw new ToolInputError(`kind 为 ${kind} 时要写 name 与 version`);
          const entry = kind === 'compiled' ? findStaticSchema(workspace, { name, version }) : workspace.staticSchemas.find((item) => item.ref.name === name && item.ref.version === version);
          return kind === 'compiled' ? entry?.compiled : entry?.definition;
        })();
        if (document === undefined) throw new ToolInputError(`工作区快照中没有这份文档：${JSON.stringify(args)}；可先用 list_documents 查看`);
        return json(document, { kind });
      },
    },
    {
      name: 'list_resources',
      description: '列出资源仓库中可引用的资源：资源 ID 与种类（image 或 font）。数据集与模板中写成 res:资源ID。',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      async call() {
        const resources = workspace.resources.list();
        return json({ resources }, { count: resources.length });
      },
    },
    {
      name: 'check_definitions',
      description: '按给出的顺序在内存中发布工作目录内的数据定义文件（被引用的放前面），返回每个文件将发布成的名称与版本，以及带位置的问题。' +
        '版本号接在工作区快照中同名定义之后，也可以引用快照中已发布的定义。includeCompiled 为 true 时附上编译产物。不写任何文件。',
      inputSchema: { type: 'object', additionalProperties: false, required: ['paths'], properties: {
        paths: paths('工作目录内的数据定义文件，被引用的放前面'),
        includeCompiled: { type: 'boolean', description: '附上编译产物 JSON Schema，缺省为 false' },
      } },
      async call(args) {
        const { results } = await publishCandidates(args['paths'] as string[]);
        const includeCompiled = args['includeCompiled'] === true;
        return json({ results: results.map(({ entry, ...result }) => ({
          ...result, problems: shown(result.problems), ...(includeCompiled && entry ? { compiled: entry.compiled } : {}),
        })) }, { published: results.filter((result) => result.published).length, of: results.length });
      },
    },
    {
      name: 'check_dataset',
      description: '校验工作目录内的一份数据集文件：按它选定的静态数据定义的编译产物校验数据，并检查 res: 资源引用。' +
        '所选定义可以是工作区快照中已发布的，也可以是 definitionPaths 中的候选（先按顺序在内存中发布）。返回带字段路径的问题。不写任何文件。',
      inputSchema: { type: 'object', additionalProperties: false, required: ['path'], properties: {
        path: { type: 'string', minLength: 1, description: '工作目录内的数据集文件' },
        definitionPaths: paths('工作目录内的候选数据定义文件，被引用的放前面'),
      } },
      async call(args) {
        const path = args['path'] as string;
        const candidates = args['definitionPaths'] ? await publishCandidates(args['definitionPaths'] as string[]) : undefined;
        const schemas = [...workspace.staticSchemas, ...(candidates?.published ?? [])];
        const problems: Problem[] = [];
        let staticSchema: unknown = null;
        const where = { kind: 'input', source: path } as const;
        try {
          const { document, tooPrecise } = await files.readJson(path);
          const parsed = parseDatasetDocument(document);
          if (typeof parsed === 'string') problems.push(severe(ProblemCodes.inputUnreadable, where, parsed));
          else {
            staticSchema = parsed.dataset.staticSchema;
            for (const literal of tooPrecise) problems.push(severe(ProblemCodes.datasetTooManyDigits, where, `数值 ${literal} 超过 15 位有效数字，按双精度读取会失真（M112）`));
            const entry = findStaticSchema({ staticSchemas: schemas }, parsed.dataset.staticSchema);
            if (!entry?.compiled) {
              problems.push(severe(entry ? ProblemCodes.compiledSchemaMissing : ProblemCodes.staticSchemaNotFound, where,
                `找不到静态数据定义“${formatStaticSchemaRef(parsed.dataset.staticSchema)}”的编译产物：既不在工作区快照中，也不在 definitionPaths 的候选中`));
            } else {
              try { problems.push(...validateDataset(entry.compiled, parsed.data, workspace.resources)); }
              catch (error) {
                if (!(error instanceof CompiledSchemaError)) throw error;
                problems.push(severe(ProblemCodes.inputUnreadable, where, `编译产物无法使用：${error.message}`));
              }
            }
          }
        } catch (error) {
          if (!(error instanceof ToolInputError)) throw error;
          problems.push(severe(ProblemCodes.inputUnreadable, where, error.message));
        }
        return json({
          ...(candidates ? { definitions: candidates.results.map(({ entry: _entry, ...result }) => ({ ...result, problems: shown(result.problems) })) } : {}),
          dataset: { path, staticSchema, problems: shown(problems) },
        }, { datasetProblems: problems.length });
      },
    },
    {
      name: 'check_templates',
      description: '对工作目录内的模板文件（工作副本）做静态检查：结构、变量与类型、调用与循环的基准、参数等。工作副本按模板名代替工作区快照中的同名模板，或作为新模板加入；' +
        '被调模板先在工作副本中找，再在快照中找。返回带元素路径的问题（同一问题只报一次）。不写任何文件，不改动已保存的模板。',
      inputSchema: { type: 'object', additionalProperties: false, required: ['paths'], properties: { paths: paths('工作目录内的模板文件') } },
      async call(args) {
        const problems: Problem[] = [];
        const copies: { path: string; entry: TemplateEntry }[] = [];
        for (const path of args['paths'] as string[]) {
          try { copies.push({ path, entry: await readWorkingCopy(path) }); }
          catch (error) {
            if (!(error instanceof ToolInputError)) throw error;
            problems.push(severe(ProblemCodes.inputUnreadable, { kind: 'input', source: path }, error.message));
          }
        }
        const overlay = withWorkingCopies(copies);
        for (const { entry } of copies) {
          const parsed = parseTemplate(entry.name, entry.document);
          problems.push(...parsed.problems);
          if (!parsed.model) continue;
          const schema = findStaticSchema(overlay.workspace, parsed.model.base);
          if (!schema?.compiled) {
            problems.push(severe(schema ? ProblemCodes.compiledSchemaMissing : ProblemCodes.staticSchemaNotFound, { kind: 'input', source: `${entry.source}#base` },
              `模板基准“${formatStaticSchemaRef(parsed.model.base)}”不在工作区快照中`));
            continue;
          }
          problems.push(...prepareTemplates(overlay.workspace, parsed.model, schema.compiled).problems);
        }
        const unique = [...new Map(problems.map((problem) => [JSON.stringify(problem), problem])).values()];
        return json({ templates: overlay.copies, problems: shown(unique) }, { templates: copies.length, problems: unique.length });
      },
    },
    {
      name: 'render_draft',
      description: `按渲染请求出一张草稿预览图（PNG），返回问题清单与图片。request 是渲染请求（template、dataset、parameters、output）；mode 只能是 draft 或省略，output.format 只能是 png 或省略。` +
        `DPI 上限 ${DRAFT_MAX_DPI}，且图片最长边不超过 ${DRAFT_MAX_SIDE_PX} 像素，超出时自动降低并在结果中注明；省略 dpi 时取上限。` +
        'templates 列出工作目录内的模板文件作为工作副本，代替同名的已保存模板（也可以是新模板）；datasetPath 用工作目录内的数据集文件代替 request.dataset。' +
        'region 只返回画板上的一块区域（毫米，相对画板左上角），DPI 按区域大小提高，用于放大核对预览中的小字与标记。不写任何文件。',
      inputSchema: { type: 'object', additionalProperties: false, required: ['request'], properties: {
        ...DRAFT_INPUT,
        region: { type: 'object', additionalProperties: false, required: ['x', 'y', 'width', 'height'], description: '画板上的区域，毫米，相对画板左上角',
          properties: { x: { type: 'number', minimum: 0 }, y: { type: 'number', minimum: 0 }, width: { type: 'number', exclusiveMinimum: 0 }, height: { type: 'number', exclusiveMinimum: 0 } } },
      } },
      async call(args) {
        const draft = await prepareDraft(args, args['region'] as Region | undefined);
        const result = await render(draft.workspace, draft.request);
        let encoded = result.image && { bytes: result.image.bytes, widthPx: result.image.widthPx, heightPx: result.image.heightPx, dpi: result.image.dpi };
        if (encoded && draft.region) {
          const { x, y, width, height } = draft.region, dpi = encoded.dpi;
          const left = Math.min(encoded.widthPx - 1, mmToPx(x, dpi)), top = Math.min(encoded.heightPx - 1, mmToPx(y, dpi));
          const right = Math.max(left + 1, Math.min(encoded.widthPx, mmToPx(x + width, dpi))), bottom = Math.max(top + 1, Math.min(encoded.heightPx, mmToPx(y + height, dpi)));
          encoded = { ...encoded, bytes: await crop(encoded.bytes, left, top, right - left, bottom - top), widthPx: right - left, heightPx: bottom - top };
        }
        const content: ContentBlock[] = [{ type: 'text', text: JSON.stringify({
          ...draft.info,
          image: encoded ? { widthPx: encoded.widthPx, heightPx: encoded.heightPx, dpi: encoded.dpi } : null,
          problems: shown(result.problems),
        }) }];
        if (encoded) content.push({ type: 'image', data: Buffer.from(encoded.bytes).toString('base64'), mimeType: 'image/png' });
        return { content, summary: { problems: result.problems.length, image: encoded !== undefined, ...(draft.region ? { region: true } : {}) } };
      },
    },
    {
      name: 'inspect_layout',
      description: '按与 render_draft 相同的输入排版，返回元素的布局摘要：元素路径、类型、位置与尺寸（毫米，相对画板左上角，未计旋转）、是否显示、子元素数；' +
        '文字另有内容、字体、字号、实际宽高、字距、压缩比（1 为不压缩）与是否溢出，图片、二维码与条形码另有绘制区域。摘要与草稿预览图一致，缺值处是占位文字。' +
        `elements 是元素路径（如 主模板/面板/列表[3]/名称，循环项带序号），省略时从画板开始；depth 是向下展开的层数，缺省 1；一次最多 ${INSPECT_MAX_NODES} 个元素。结果同时给出这些元素上的问题。不写任何文件。`,
      inputSchema: { type: 'object', additionalProperties: false, required: ['request'], properties: {
        ...DRAFT_INPUT,
        elements: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 }, description: '元素路径' },
        depth: { type: 'integer', minimum: 0, maximum: 20, description: '向下展开的层数，0 只看元素本身，缺省 1' },
      } },
      async call(args) {
        const draft = await prepareDraft(args);
        const result = await render(draft.workspace, draft.request);
        if (!result.layout) return json({ ...draft.info, layout: null, problems: shown(result.problems) }, { problems: result.problems.length, layout: false });
        const byPath = new Map<string, LayoutNode>();
        const index = (node: LayoutNode) => { byPath.set(node.path, node); node.children?.forEach(index); };
        index(result.layout.root);
        const requested = (args['elements'] as string[] | undefined) ?? [result.layout.root.path];
        const depth = (args['depth'] as number | undefined) ?? 1;
        const nodes: Record<string, unknown>[] = [], notFound: { path: string; suggestions: string[] }[] = [];
        let truncated = false;
        const collect = (node: LayoutNode, remaining: number) => {
          if (nodes.length >= INSPECT_MAX_NODES) { truncated = true; return; }
          nodes.push(nodeView(node));
          if (remaining > 0) node.children?.forEach((child) => collect(child, remaining - 1));
        };
        for (const path of requested) {
          const node = byPath.get(path);
          if (node) collect(node, depth);
          else notFound.push({ path, suggestions: suggestPaths(path, byPath, result.layout.root) });
        }
        const under = (path: string) => requested.some((root) => path === root || path.startsWith(`${root}/`) || path.startsWith(`${root}[`));
        const problems = result.problems.filter((problem) => {
          const path = 'path' in problem.location ? problem.location.path : undefined;
          return args['elements'] === undefined || (path !== undefined && under(path));
        });
        return json({
          ...draft.info, output: result.layout.output, nodes: roundNumbers(nodes),
          ...(truncated ? { truncated: true } : {}), ...(notFound.length ? { notFound } : {}),
          problems: shown(problems),
        }, { nodes: nodes.length, notFound: notFound.length });
      },
    },
    {
      name: 'view_image',
      description: `局部放大查看图片：工作目录内的图片（如示例图），或写 res:资源ID 查看资源仓库中图片资源的当前版本。按像素区域裁切，放大到最长边约 ${VIEW_MAX_SIDE_PX} 像素（最多 ${VIEW_MAX_SCALE} 倍），返回 PNG 与原图尺寸。` +
        '用于核对小字、密排列表、图标与小标记，以及把示例图上的图标、标记与资源图片对照后再引用。省略 region 时返回整图；区域超出原图时按原图边界裁切。不写任何文件。',
      inputSchema: { type: 'object', additionalProperties: false, required: ['path'], properties: {
        path: { type: 'string', minLength: 1, description: '工作目录内的图片，如 sample.png；或 res:资源ID，如 res:landmark-1（只能是图片资源，可先用 list_resources 查看）' },
        region: { type: 'object', additionalProperties: false, required: ['x', 'y', 'width', 'height'], description: '原图像素区域，左上角为原点',
          properties: { x: { type: 'number', minimum: 0 }, y: { type: 'number', minimum: 0 }, width: { type: 'number', exclusiveMinimum: 0 }, height: { type: 'number', exclusiveMinimum: 0 } } },
      } },
      async call(args) {
        const ck = await loadCanvasKit();
        const path = args['path'] as string;
        const source = path.startsWith('res:') ? await readResourceImage(ck, path) : await readImageFile(ck, path);
        const surfaces: { delete(): void }[] = source.image ? [source.image] : [];
        try {
          const W = source.width, H = source.height;
          const region = args['region'] as Record<string, number> | undefined;
          const x = Math.min(W - 1, Math.round(region?.['x'] ?? 0)), y = Math.min(H - 1, Math.round(region?.['y'] ?? 0));
          const w = Math.max(1, Math.min(W - x, Math.round(region?.['width'] ?? W))), h = Math.max(1, Math.min(H - y, Math.round(region?.['height'] ?? H)));
          const scale = Math.min(VIEW_MAX_SCALE, VIEW_MAX_SIDE_PX / Math.max(w, h));
          const ow = Math.max(1, Math.round(w * scale)), oh = Math.max(1, Math.round(h * scale));
          // SVG 按放大后的尺寸栅格化整图，区域换算到栅格上；位图的换算比是 1。
          let image = source.image;
          if (!image) {
            image = ck.MakeImageFromEncoded(rasterizeSvg(source.svg!, svgRasterWidth(W, H, scale))) ?? undefined;
            if (!image) throw new Error('SVG 栅格结果无法解码');
            surfaces.push(image);
          }
          const k = image.width() / W;
          const surface = ck.MakeSurface(ow, oh);
          if (!surface) throw new Error('无法创建绘图表面');
          const paint = new ck.Paint();
          surfaces.push(surface, paint);
          surface.getCanvas().drawImageRectOptions(image, ck.XYWHRect(x * k, y * k, w * k, h * k), ck.XYWHRect(0, 0, ow, oh), ck.FilterMode.Linear, ck.MipmapMode.Linear, paint);
          const snapshot = surface.makeImageSnapshot();
          surfaces.push(snapshot);
          const bytes = snapshot.encodeToBytes();
          if (!bytes) throw new Error('无法编码 PNG');
          return {
            content: [
              { type: 'text', text: JSON.stringify({ original: { width: W, height: H }, region: { x, y, width: w, height: h }, scale: Math.round(scale * 100) / 100, output: { width: ow, height: oh } }) },
              { type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType: 'image/png' },
            ],
            summary: { region: [x, y, w, h], scale: Math.round(scale * 100) / 100 },
          };
        } finally {
          for (const item of surfaces.reverse()) item.delete();
        }
      },
    },
    {
      name: 'dsl_reference',
      description: '返回 DSL 参考或 JSON Schema 原文。name 取 reference/data-definition（数据定义与数据集参考）、reference/template（模板参考），' +
        '或 schema/data-definition、schema/dataset、schema/template、schema/render-request、schema/batch-request（JSON Schema 2020-12）。',
      inputSchema: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { enum: Object.keys(REFERENCE_FILES) } } },
      async call(args) {
        const file = REFERENCE_FILES[args['name'] as keyof typeof REFERENCE_FILES];
        const text = await readFile(join(REPO_ROOT, file), 'utf8');
        return { content: [{ type: 'text', text }], summary: { name: args['name'], chars: text.length } };
      },
    },
    {
      name: 'check_outcome',
      description: '交回前核对成果：按 RenderWeave 收到成果后的同一套规则，检查工作目录根上的 outcome.json 与其中列出的候选文件。' +
        '查 outcome.json 的结构，候选文件的位置与种类，待确认项与图上位置引用的文件和路径（数据定义写字段名，数据集写字段路径，模板写元素路径），再用引擎校验候选。' +
        '返回结论 verdict（qualified 合格、unqualified 不合格）、outcome.json 的问题 problems 与每个候选的问题；数据集中落在待确认位置上的问题列在 deferred，留给审核，不影响结论。不写任何文件。',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      async call() {
        if (!context.outcome) throw new ToolInputError('服务启动时没有给出本轮任务（--outcome-context），无法核对成果');
        const { task, ...known } = context.outcome;
        const check = await checkAgentOutcome({ task, agentDir: files.root, workspace, context: known });
        return json({
          verdict: check.verdict,
          problems: shown(check.problems),
          candidates: check.candidates.map(({ sha256: _sha256, revision: _revision, problems, deferred, ...candidate }) => ({
            ...candidate, problems: shown(problems), ...(deferred ? { deferred: shown(deferred) } : {}),
          })),
        }, { verdict: check.verdict, problems: check.problems.length + check.candidates.reduce((sum, candidate) => sum + candidate.problems.length, 0) });
      },
    },
  ];
  return tools;

  async function publishCandidates(list: readonly string[]) {
    const published: StaticSchemaEntry[] = [];
    const results: { path: string; published: { name: string; version: number } | null; problems: Problem[]; entry?: StaticSchemaEntry }[] = [];
    for (const path of list) {
      try {
        const { document, tooPrecise } = await files.readJson(path);
        if (tooPrecise.length > 0) {
          results.push({ path, published: null, problems: [severe(ProblemCodes.definitionInvalid, { kind: 'input', source: path },
            `数值超过 15 位有效数字，按双精度读取会失真：${tooPrecise.join('、')}`)] });
          continue;
        }
        const outcome = publishStaticSchema(document, [...workspace.staticSchemas, ...published]);
        if (outcome.published) published.push(outcome.published);
        results.push({ path, published: outcome.published ? { ...outcome.published.ref } : null, problems: outcome.problems, ...(outcome.published ? { entry: outcome.published } : {}) });
      } catch (error) {
        if (!(error instanceof ToolInputError)) throw error;
        results.push({ path, published: null, problems: [severe(ProblemCodes.inputUnreadable, { kind: 'input', source: path }, error.message)] });
      }
    }
    return { published, results };
  }

  async function readImageFile(ck: CanvasKit, path: string): Promise<LoadedImage> {
    const image = ck.MakeImageFromEncoded(await files.readBytes(path));
    if (!image) throw new ToolInputError(`无法解码图片：${path}`);
    return { id: path, image, width: image.width(), height: image.height() };
  }

  /** `res:资源ID` 只经资源仓库接口按 ID 读，不按路径读资源仓库目录；版本仓库是启动时固定的当前版本。 */
  async function readResourceImage(ck: CanvasKit, ref: string): Promise<LoadedImage> {
    const id = parseResourceRef(ref);
    if (id === undefined) throw new ToolInputError(`res: 后面只能写资源 ID（字母、数字、- 与 _），如 res:landmark-1；收到 ${ref}`);
    const outcome = await loadResourceImage(ck, workspace.resources, new SvgLoader(workspace.resources, DEFAULT_FALLBACK_FONTS, ck), id);
    if ('error' in outcome) {
      throw new ToolInputError(outcome.error.code === ProblemCodes.resourceNotFound ? `${outcome.error.message}；可先用 list_resources 查看` : outcome.error.message);
    }
    return outcome.image;
  }

  async function readWorkingCopy(path: string): Promise<TemplateEntry> {
    const { document } = await files.readJson(path);
    if (!isRecord(document) || typeof document['dslVersion'] !== 'string' || !document['dslVersion'].startsWith('renderweave-template/')) {
      throw new ToolInputError(`不是模板文档（dslVersion 应为 renderweave-template/1）：${path}`);
    }
    const name = document['name'];
    if (typeof name !== 'string' || name.trim() === '') throw new ToolInputError(`模板缺少名称：${path}`);
    return { name, document, source: path };
  }

  function withWorkingCopies(copies: readonly { path: string; entry: TemplateEntry }[]) {
    const seen = new Map<string, string>();
    for (const { path, entry } of copies) {
      const other = seen.get(entry.name);
      if (other !== undefined) throw new ToolInputError(`工作副本的模板名重复：${entry.name}（${other}、${path}）`);
      seen.set(entry.name, path);
    }
    const names = new Set(copies.map(({ entry }) => entry.name));
    return {
      workspace: { ...workspace, templates: [...workspace.templates.filter((entry) => !names.has(entry.name)), ...copies.map(({ entry }) => entry)] },
      copies: copies.map(({ path, entry }) => ({ path, name: entry.name, replaces: workspace.templates.some((saved) => saved.name === entry.name) })),
    };
  }

  /** 草稿预览与元素检查共用：叠加工作副本，换入数据集文件，固定为草稿并限制 DPI；局部预览按区域大小定 DPI。 */
  async function prepareDraft(args: Record<string, unknown>, region?: Region) {
    const request = { ...(args['request'] as Record<string, unknown>) };
    if (request['mode'] !== undefined && request['mode'] !== 'draft') throw new ToolInputError('只能草稿预览：request.mode 只能是 draft 或省略');
    const copies: { path: string; entry: TemplateEntry }[] = [];
    for (const path of (args['templates'] as string[] | undefined) ?? []) copies.push({ path, entry: await readWorkingCopy(path) });
    const overlay = withWorkingCopies(copies);
    const datasetPath = args['datasetPath'] as string | undefined;
    if (datasetPath !== undefined) {
      if (request['dataset'] !== undefined) throw new ToolInputError('request.dataset 与 datasetPath 只能写一个');
      const { document, tooPrecise } = await files.readJson(datasetPath);
      if (tooPrecise.length > 0) throw new ToolInputError(`数据集中的数值超过 15 位有效数字，按双精度读取会失真：${tooPrecise.join('、')}`);
      request['dataset'] = { inline: document };
    }
    let dpiNote: Record<string, number> = {};
    let clipped: Region | undefined;
    if (isRecord(request['output'])) {
      const output = { ...request['output'] };
      if (output['format'] !== undefined && output['format'] !== 'png') throw new ToolInputError('草稿预览只输出 PNG：request.output.format 只能是 png 或省略');
      output['format'] = 'png';
      const { width, height, dpi } = output;
      if (typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0 && (dpi === undefined || typeof dpi === 'number')) {
        if (region) {
          if (region.x >= width || region.y >= height) throw new ToolInputError(`region 在画板之外：画板为 ${width} × ${height} mm`);
          clipped = { x: region.x, y: region.y, width: Math.min(region.width, width - region.x), height: Math.min(region.height, height - region.y) };
        }
        // 局部预览不看请求的 DPI，按区域定：区域最长边不超过像素上限，整图像素数也有上限。
        const side = clipped ? Math.max(clipped.width, clipped.height) : Math.max(width, height);
        const whole = clipped ? Math.floor(25.4 * Math.sqrt(DRAFT_REGION_MAX_TOTAL_PX / (width * height))) : DRAFT_MAX_DPI;
        const limit = Math.max(1, Math.min(DRAFT_MAX_DPI, whole, Math.floor((DRAFT_MAX_SIDE_PX * 25.4) / side)));
        if (dpi === undefined || dpi > limit || clipped) output['dpi'] = limit;
        if (typeof dpi === 'number' && dpi > limit && !clipped) dpiNote = { requestedDpi: dpi };
      }
      request['output'] = output;
    }
    if (region && !clipped) throw new ToolInputError('写 region 时，request.output 要有 width 与 height');
    request['mode'] = 'draft';
    return {
      workspace: overlay.workspace,
      request,
      region: clipped,
      info: { workingCopies: overlay.copies, ...(datasetPath !== undefined ? { datasetPath } : {}), ...dpiNote, ...(clipped ? { region: roundNumbers(clipped) } : {}) },
    };
  }
}

interface Region { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

/** SVG 资源整图栅格化的宽度：按放大倍数取，单边与像素总数超限时降低清晰度。 */
function svgRasterWidth(width: number, height: number, scale: number): number {
  const limit = Math.min(VIEW_SVG_MAX_SIDE_PX, (VIEW_SVG_MAX_SIDE_PX * width) / height, Math.sqrt((VIEW_SVG_MAX_TOTAL_PX * width) / height));
  return Math.max(1, Math.min(Math.ceil(width * scale), Math.floor(limit)));
}

/** 从整张预览中裁出像素区域，重新编码为 PNG。 */
async function crop(bytes: Uint8Array, left: number, top: number, width: number, height: number): Promise<Uint8Array> {
  const ck = await loadCanvasKit();
  const image = ck.MakeImageFromEncoded(bytes);
  const surface = ck.MakeSurface(width, height);
  const paint = new ck.Paint();
  try {
    if (!image || !surface) throw new Error('无法裁切预览图');
    surface.getCanvas().drawImageRect(image, ck.XYWHRect(left, top, width, height), ck.XYWHRect(0, 0, width, height), paint);
    const snapshot = surface.makeImageSnapshot();
    const encoded = snapshot.encodeToBytes();
    snapshot.delete();
    if (!encoded) throw new Error('无法编码 PNG');
    return encoded;
  } finally {
    paint.delete(); surface?.delete(); image?.delete();
  }
}

function json(value: unknown, summary?: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], ...(summary ? { summary } : {}) };
}

function displayName(entry: StaticSchemaEntry): string | undefined {
  const value = isRecord(entry.definition) ? entry.definition['displayName'] : undefined;
  return typeof value === 'string' ? value : undefined;
}

/** 问题位置里的宿主机路径改写为"工作区/…"或"资源仓库/…"，不把宿主目录交给 Agent。 */
function displayProblem(problem: Problem, context: ToolContext): Problem {
  if (problem.location.kind !== 'input') return problem;
  const source = problem.location.source;
  for (const [dir, label] of [[context.workspaceDir, '工作区'], [context.resourcesDir, '资源仓库']] as const) {
    const rel = relative(dir, source);
    if (rel !== '' && !rel.startsWith('..') && !/^[A-Za-z]:|^[\\/]/.test(rel)) {
      return { ...problem, location: { kind: 'input', source: `${label}/${rel.replaceAll('\\', '/')}` } };
    }
  }
  return problem;
}

function nodeView(node: LayoutNode): Record<string, unknown> {
  const { text, image, qrcode, barcode } = node;
  return {
    path: node.path, type: node.type, x: node.x, y: node.y, width: node.width, height: node.height, visible: node.visible,
    children: node.children?.length ?? 0,
    ...(text ? { text: {
      content: text.content, font: text.font, fontSize: text.fontSize, writingMode: text.writingMode, width: text.width, height: text.height,
      spacing: text.spacing, compression: text.compression, overflow: text.overflow,
      ...(text.shrinkGroup ? { shrinkGroup: text.shrinkGroup } : {}), ...(text.fontFallback ? { fontFallback: true } : {}),
      ...(text.fragments.some((fragment) => fragment.placeholder) ? { placeholder: true } : {}),
    } } : {}),
    ...(image ? { image: { source: image.source, fit: image.fit, ...(image.tint ? { tint: image.tint } : {}), naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, drawn: image.drawn } } : {}),
    ...(qrcode ? { qrcode: { errorCorrectionLevel: qrcode.errorCorrectionLevel, modules: qrcode.modules, drawn: qrcode.drawn, symbol: qrcode.symbol } } : {}),
    ...(barcode ? { barcode: { format: barcode.format, drawn: barcode.drawn, symbol: barcode.symbol, ...(barcode.label ? { label: barcode.label.text.content } : {}) } } : {}),
  };
}

/** 找不到元素路径时，给出同名元素或画板的直接子元素。 */
function suggestPaths(path: string, byPath: ReadonlyMap<string, LayoutNode>, root: LayoutNode): string[] {
  const last = path.split('/').pop()!.replace(/\[\d+\]$/, '');
  const same = [...byPath.values()].filter((node) => node.name === last).map((node) => node.path);
  return (same.length > 0 ? same : [root.path, ...(root.children ?? []).map((child) => child.path)]).slice(0, 10);
}

function roundNumbers<T>(value: T): T {
  if (typeof value === 'number') return (Math.round(value * 1000) / 1000) as T;
  if (Array.isArray(value)) return value.map(roundNumbers) as T;
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, roundNumbers(item)])) as T;
  return value;
}
