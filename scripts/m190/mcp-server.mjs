// M190 验证用的最小 MCP 服务（stdio，按行分隔的 JSON-RPC），由 run.mjs 启动；不是阶段 3 的正式工具实现。
// 工具全部只读：进程内调用引擎 dist 做校验与草稿预览，不写工作区、不写资源仓库，文件只能读 --root 之内。
// 用法：node mcp-server.mjs --workspace <工作区目录> --resources <资源仓库> --root <Agent 工作目录> --log <调用日志> --tools a,b
import { readFile, appendFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

console.log = (...a) => console.error(...a); // stdout 只留给协议

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const REPO = resolve(fileURLToPath(import.meta.url), '../../..'), WS = opt('workspace'), RES = opt('resources'), ROOT = opt('root'), LOG = opt('log');
const ENABLED = new Set((opt('tools') ?? 'render_draft,check_definitions,check_dataset,list_resources,view_image').split(','));

const engine = await import(pathToFileURL(join(REPO, 'dist/index.js')).href);
const { validateDataset } = await import(pathToFileURL(join(REPO, 'dist/dataset-validation.js')).href);
const { parseDatasetDocument } = await import(pathToFileURL(join(REPO, 'dist/workspace.js')).href);

const formatProblems = (problems) => problems.length === 0 ? '没有问题。' :
  problems.map((p) => `- [${p.level}] ${p.code} @ ${JSON.stringify(p.location)}：${p.message}`).join('\n');

/** 只允许读 Agent 工作目录内的文件。 */
async function readInRoot(path) {
  const full = resolve(ROOT, path);
  const rel = relative(ROOT, full);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`只能读取工作目录内的文件：${path}`);
  return readFile(full);
}
const readJsonInRoot = async (path) => JSON.parse((await readInRoot(path)).toString('utf8'));

let canvasKit;
const VIEW_MAX_SIDE = 1400;

async function publishAll(paths) {
  const published = [], report = [];
  for (const path of paths) {
    let doc;
    try { doc = await readJsonInRoot(path); } catch (e) { report.push(`## ${path}\n无法读取：${e.message}`); continue; }
    const { published: entry, problems } = engine.publishStaticSchema(doc, published);
    if (entry) published.push(entry);
    report.push(`## ${path}\n${entry ? `发布为 ${entry.ref.name} v${entry.ref.version}。` : '发布失败。'}\n${formatProblems(problems)}`);
  }
  return { published, report };
}

const TOOLS = {
  render_draft: {
    description: '按渲染请求用引擎出一张草稿预览图（PNG，不写文件）。模式固定为草稿，DPI 上限 60。返回问题清单与预览图。',
    inputSchema: { type: 'object', required: ['request'], properties: { request: { type: 'object', description: '渲染请求：template、dataset（{id} 或 {inline: 数据集文档}）、parameters、output{width,height,dpi,format}' } } },
    async call({ request }) {
      const workspace = await engine.loadWorkspace({ dir: WS, resourcesDir: RES });
      const output = { ...(request?.output ?? {}), dpi: Math.min(Number(request?.output?.dpi ?? 50), 60), format: 'png' };
      const result = await engine.render(workspace, { ...request, mode: 'draft', output });
      const content = [{ type: 'text', text: `问题 ${result.problems.length} 个：\n${formatProblems(result.problems)}` }];
      if (result.image) {
        content[0].text += `\n预览图 ${result.image.widthPx}×${result.image.heightPx} px，${result.image.dpi} DPI。`;
        content.push({ type: 'image', data: Buffer.from(result.image.bytes).toString('base64'), mimeType: 'image/png' });
      }
      return { content, summary: { problems: result.problems.length, image: !!result.image } };
    },
  },
  check_definitions: {
    description: '按给出的顺序在内存中发布数据定义 DSL 文件（被引用的放前面），返回每个文件的问题清单与编译结果。不写任何文件。',
    inputSchema: { type: 'object', required: ['paths'], properties: { paths: { type: 'array', items: { type: 'string' }, description: '工作目录内的数据定义文件路径' } } },
    async call({ paths }) {
      const { published, report } = await publishAll(paths);
      const compiled = published.map((p) => `### ${p.ref.name} v${p.ref.version} 编译产物\n${JSON.stringify(p.compiled)}`);
      return { content: [{ type: 'text', text: [...report, ...compiled].join('\n\n') }], summary: { published: published.length, of: paths.length } };
    },
  },
  check_dataset: {
    description: '先在内存中发布数据定义，再按数据集选定的静态数据定义的编译产物校验数据集，并检查 res: 资源引用。不写任何文件。',
    inputSchema: { type: 'object', required: ['definitionPaths', 'datasetPath'], properties: {
      definitionPaths: { type: 'array', items: { type: 'string' } }, datasetPath: { type: 'string' } } },
    async call({ definitionPaths, datasetPath }) {
      const { published, report } = await publishAll(definitionPaths);
      const doc = await readJsonInRoot(datasetPath);
      const parsed = parseDatasetDocument(doc);
      if (typeof parsed === 'string') return { content: [{ type: 'text', text: `${report.join('\n\n')}\n\n## ${datasetPath}\n${parsed}` }], summary: { datasetProblems: 1 } };
      const ref = parsed.dataset.staticSchema;
      const target = published.find((p) => p.ref.name === ref.name && p.ref.version === ref.version);
      if (!target) return { content: [{ type: 'text', text: `${report.join('\n\n')}\n\n## ${datasetPath}\n找不到静态数据定义 ${ref.name} v${ref.version}` }], summary: { datasetProblems: 1 } };
      const { repository } = await engine.openResourceRepository(RES);
      const problems = validateDataset(target.compiled, parsed.data, repository);
      return { content: [{ type: 'text', text: `${report.join('\n\n')}\n\n## ${datasetPath}（按 ${ref.name} v${ref.version} 校验）\n${formatProblems(problems)}` }], summary: { datasetProblems: problems.length } };
    },
  },
  view_image: {
    description: '局部放大查看工作目录内的图片（如示例图、预览图）：按像素区域裁切，放大到最长边约 1400 px，返回 PNG。用于核对小字、密排列表、图标与小标记。省略 region 时返回整图并给出原图尺寸。不写文件。',
    inputSchema: { type: 'object', required: ['path'], properties: {
      path: { type: 'string', description: '工作目录内的图片路径，如 sample.png' },
      region: { type: 'object', description: '原图像素区域，左上角为原点', properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } } },
    } },
    async call({ path, region }) {
      canvasKit ??= await (await import(pathToFileURL(join(REPO, 'dist/canvaskit.js')).href)).loadCanvasKit();
      const ck = canvasKit;
      const image = ck.MakeImageFromEncoded(await readInRoot(path));
      if (!image) throw new Error(`无法解码图片：${path}`);
      const W = image.width(), H = image.height();
      const x = Math.max(0, Math.min(W - 1, Math.round(region?.x ?? 0))), y = Math.max(0, Math.min(H - 1, Math.round(region?.y ?? 0)));
      const w = Math.max(1, Math.min(W - x, Math.round(region?.width ?? W))), h = Math.max(1, Math.min(H - y, Math.round(region?.height ?? H)));
      const scale = Math.min(4, VIEW_MAX_SIDE / Math.max(w, h));
      const ow = Math.max(1, Math.round(w * scale)), oh = Math.max(1, Math.round(h * scale));
      const surface = ck.MakeSurface(ow, oh);
      const paint = new ck.Paint();
      surface.getCanvas().drawImageRectOptions(image, ck.XYWHRect(x, y, w, h), ck.XYWHRect(0, 0, ow, oh), ck.FilterMode.Linear, ck.MipmapMode.Linear, paint);
      const bytes = surface.makeImageSnapshot().encodeToBytes();
      image.delete(); surface.delete(); paint.delete();
      return {
        content: [
          { type: 'text', text: `原图 ${W}×${H} px；区域 x=${x} y=${y} 宽 ${w} 高 ${h}；放大 ${scale.toFixed(2)} 倍，输出 ${ow}×${oh} px。` },
          { type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType: 'image/png' },
        ],
        summary: { region: [x, y, w, h], scale: Number(scale.toFixed(2)) },
      };
    },
  },
  list_resources: {
    description: '列出资源仓库中可引用的资源 ID 与类型（数据集里写成 res:资源ID）。',
    inputSchema: { type: 'object', properties: {} },
    async call() {
      const manifest = JSON.parse(await readFile(join(RES, 'resources.json'), 'utf8'));
      const lines = manifest.resources.map((r) => `- ${r.id}（${r.kind}）${r.description ? '：' + r.description : ''}`);
      return { content: [{ type: 'text', text: lines.join('\n') }], summary: { count: lines.length } };
    },
  },
};

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (id === undefined) return; // 通知
  try {
    if (method === 'initialize') {
      send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'renderweave-m190', version: '0.0.1' } } });
    } else if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: Object.entries(TOOLS).filter(([n]) => ENABLED.has(n)).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) } });
    } else if (method === 'tools/call') {
      const tool = ENABLED.has(params.name) ? TOOLS[params.name] : undefined;
      const t0 = Date.now();
      if (!tool) { send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `未知工具 ${params.name}` }], isError: true } }); return; }
      let result, isError = false;
      try { result = await tool.call(params.arguments ?? {}); } catch (e) { isError = true; result = { content: [{ type: 'text', text: `工具出错：${e.message}` }], summary: { error: e.message } }; }
      if (LOG) await appendFile(LOG, JSON.stringify({ at: new Date().toISOString(), tool: params.name, arguments: params.arguments, ms: Date.now() - t0, isError, ...result.summary }) + '\n');
      send({ jsonrpc: '2.0', id, result: { content: result.content, isError } });
    } else if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} });
    } else {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `不支持 ${method}` } });
    }
  } catch (e) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e?.message ?? e) } });
  }
});
