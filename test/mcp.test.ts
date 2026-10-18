/**
 * `renderweave mcp` 的合同测试（第三阶段票据 03、验收 A04）：用 JSON-RPC 直接驱动命令，不经模型。
 * 共享 M402 样例作为工作区快照；每次会话结束后核对工作区、资源仓库与工作目录都没有变化。
 */
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { mmToPx, readPngInfo } from '../src/index.js';
import { startMcp, type McpSession, type ToolCall } from './support/mcp-client.js';
import { m402Dir, repoRoot, resourcesDir, singleTextDir } from './support/fixtures.js';

const REQUEST = {
  template: '标准线路单边', dataset: { id: 'ds-m402-wanguocheng' }, parameters: { currentIndex: 5 },
  output: { width: 740, height: 165, dpi: 20 },
};
const READ_ONLY_TOOLS = ['list_documents', 'read_document', 'list_resources', 'check_definitions', 'check_dataset', 'check_templates',
  'render_draft', 'inspect_layout', 'view_image', 'dsl_reference', 'check_outcome'];
const NOTE = { dslVersion: 'renderweave-schema/1', name: '便签', fields: [{ name: 'title', displayName: '标题', type: 'text', constraints: { required: true, maxLength: 4 } }] };

let base: string, root: string, outside: string, logFile: string;
let session: McpSession;
let before: Map<string, string>;

/** 目录树指纹：小文件按内容，大文件（字体）按大小与修改时间。 */
async function fingerprint(...dirs: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isSymbolicLink()) result.set(file, 'link');
      else {
        const info = await stat(file);
        result.set(file, info.size < 2_000_000 ? createHash('sha256').update(await readFile(file)).digest('hex') : `${info.size}:${info.mtimeMs}`);
      }
    }
  };
  for (const dir of dirs) await walk(dir);
  return result;
}

const text = (result: ToolCall) => (result.content.find((block) => block.type === 'text') as { text: string }).text;
const image = (result: ToolCall) => result.content.find((block) => block.type === 'image') as { data: string; mimeType: string } | undefined;
const codes = (problems: { code: string }[]) => problems.map((problem) => problem.code);

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'rw-mcp-'));
  root = join(base, 'round');
  outside = join(base, 'outside');
  logFile = join(base, 'tools.jsonl');
  await mkdir(join(root, 'candidates'), { recursive: true });
  await mkdir(outside);
  await writeFile(join(outside, 'secret.json'), '{"dslVersion":"renderweave-template/1"}');
  await cp(join(resourcesDir, 'images/test/quadrants.png'), join(root, 'sample.png'));
  await writeFile(join(root, 'notes.txt'), '不是图片');
  // 工作副本：站名颜色改成蓝色；另一份插槽变量拼错。
  const stop = JSON.parse(await readFile(join(m402Dir, 'template-stop.json'), 'utf8'));
  stop.parameters.find((parameter: { name: string }) => parameter.name === 'nameColor').default = '#0000FF';
  await writeFile(join(root, 'candidates/template-stop.json'), JSON.stringify(stop));
  await writeFile(join(root, 'candidates/template-stop-typo.json'), JSON.stringify(stop).replace('"slot":"name"', '"slot":"nmae"'));
  // 数据定义候选：停靠站点不写版本，接在快照的 v1 之后；另一份写死 v1，与将分配的版本不符。
  const definition = JSON.parse(await readFile(join(m402Dir, 'schema-stop-v1.json'), 'utf8'));
  await writeFile(join(root, 'candidates/schema-stop-v1.json'), JSON.stringify(definition));
  delete definition.version;
  await writeFile(join(root, 'candidates/schema-stop.json'), JSON.stringify(definition));
  await writeFile(join(root, 'candidates/schema-note.json'), JSON.stringify(NOTE));
  await writeFile(join(root, 'candidates/dataset-note.json'), JSON.stringify({ dataset: { staticSchema: { name: '便签', version: 1 } }, data: { title: '超过四个字' } }));
  const dataset = JSON.parse(await readFile(join(m402Dir, 'dataset-m402.json'), 'utf8'));
  await writeFile(join(root, 'candidates/dataset-m402.json'), JSON.stringify(dataset));
  dataset.data.stops[2].name = 123;
  await writeFile(join(root, 'candidates/dataset-m402-broken.json'), JSON.stringify(dataset));
  // 目录联接（Windows 无需管理员权限）把工作目录外的目录挂进来。
  await symlink(outside, join(root, 'link'), 'junction');

  before = await fingerprint(m402Dir, resourcesDir, root, outside);
  session = startMcp(['--workspace', m402Dir, '--resources', resourcesDir, '--root', root, '--log', logFile]);
  await session.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'contract-test', version: '0' } });
  session.sendRaw(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('协议与工具清单', () => {
  it('初始化协商协议版本，工具清单与输入 Schema 与快照一致', async () => {
    const init = await session.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const older = await session.request('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
    const unknown = await session.request('initialize', { protocolVersion: '1999-01-01', capabilities: {} });
    expect(init.result).toEqual({ protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'renderweave', version: '0.4.0' } });
    expect(older.result.protocolVersion).toBe('2024-11-05');
    expect(unknown.result.protocolVersion).toBe('2025-06-18');
    const listed = await session.request('tools/list');
    await expect(`${JSON.stringify(listed.result, null, 2)}\n`).toMatchFileSnapshot('snapshots/mcp-tools.json');
    expect((await session.request('ping')).result).toEqual({});
  });

  it('只有读取、校验、预览与参考类工具；没有写入、发布、删除与正式出图的途径', async () => {
    const tools: { name: string; description: string }[] = (await session.request('tools/list')).result.tools;
    expect(tools.map((tool) => tool.name)).toEqual(READ_ONLY_TOOLS);
    expect(tools.filter((tool) => /write|save|publish|delete|remove|apply|deliver|final/i.test(tool.name))).toEqual([]);
    expect(text(await session.call('render_draft', { request: { ...REQUEST, mode: 'final' } }))).toContain('只能草稿预览');
    expect(text(await session.call('inspect_layout', { request: { ...REQUEST, mode: 'final' } }))).toContain('只能草稿预览');
    expect(text(await session.call('render_draft', { request: { ...REQUEST, output: { ...REQUEST.output, format: 'jpg' } } }))).toContain('只输出 PNG');
  });

  it('协议错误按 JSON-RPC 回复；参数不合规作为工具错误返回，便于 Agent 修正', async () => {
    session.sendRaw('{不是 JSON');
    session.sendRaw(JSON.stringify({ id: 99, method: 'ping' }));
    expect((await session.request('resources/list')).error.code).toBe(-32601);
    const unknownTool = await session.request('tools/call', { name: 'save_template', arguments: {} });
    expect(unknownTool.error.code).toBe(-32602);
    expect(session.orphans.map((message) => [message.id, message.error.code])).toEqual([[null, -32700], [99, -32600]]);
    const missing = await session.call('read_document', {});
    expect(missing.isError).toBe(true);
    expect(text(missing)).toBe('参数不合规：参数 缺少 kind');
    expect(text(await session.call('check_templates', { paths: [], extra: true }))).toBe('参数不合规：参数 不能有 extra；paths 至少要有 1 项');
    expect(text(await session.call('dsl_reference', { name: 'schema/unknown' }))).toContain('只能取');
    for (const name of READ_ONLY_TOOLS) {
      const result = await session.call(name, { unexpected: 1 });
      expect([name, result.isError, text(result)]).toEqual([name, true, expect.stringMatching(/^参数不合规：.*参数 不能有 unexpected/)]);
    }
  });
});

describe('读取', () => {
  it('列出工作区快照中的文档与资源，按名称读出原文', async () => {
    const documents = await session.callJson('list_documents');
    expect(documents.definitions).toEqual([
      { name: '线路牌', version: 1, displayName: '线路牌（单线路单方向）', definition: true, compiled: true },
      { name: '停靠站点', version: 1, displayName: '停靠站点', definition: true, compiled: true },
    ]);
    expect(documents.templates.map((template: { name: string }) => template.name).sort()).toEqual(['标准线路单边', '标识图标', '班次时刻', '站点', '道路段']);
    expect(documents.datasets).toEqual([{ id: 'ds-m402-wanguocheng', staticSchema: { name: '线路牌', version: 1 } }]);
    expect(documents.problems).toEqual([]);

    expect(await session.callJson('read_document', { kind: 'template', name: '站点' })).toEqual(JSON.parse(await readFile(join(m402Dir, 'template-stop.json'), 'utf8')));
    expect(await session.callJson('read_document', { kind: 'dataset', id: 'ds-m402-wanguocheng' })).toEqual(JSON.parse(await readFile(join(m402Dir, 'dataset-m402.json'), 'utf8')));
    expect(await session.callJson('read_document', { kind: 'definition', name: '停靠站点', version: 1 })).toEqual(JSON.parse(await readFile(join(m402Dir, 'schema-stop-v1.json'), 'utf8')));
    expect((await session.callJson('read_document', { kind: 'compiled', name: '单值·文本', version: 1 })).required).toEqual(['value']);
    expect(text(await session.call('read_document', { kind: 'template', name: '不存在' }))).toContain('工作区快照中没有这份文档');
    expect(text(await session.call('read_document', { kind: 'definition', name: '线路牌' }))).toContain('要写 name 与 version');

    const { resources } = await session.callJson('list_resources');
    expect(resources).toContainEqual({ id: 'font-hei-regular', kind: 'font' });
    expect(resources).toContainEqual({ id: 'route-no-m402', kind: 'image' });
  });

  it('DSL 参考与 JSON Schema 原样返回', async () => {
    const files = { 'reference/data-definition': 'agent/reference/data-definition.md', 'reference/template': 'agent/reference/template.md',
      'schema/data-definition': 'schemas/data-definition.schema.json', 'schema/dataset': 'schemas/dataset.schema.json',
      'schema/template': 'schemas/template.schema.json', 'schema/render-request': 'schemas/render-request.schema.json',
      'schema/batch-request': 'schemas/batch-request.schema.json' };
    for (const [name, file] of Object.entries(files)) {
      expect(text(await session.call('dsl_reference', { name }))).toBe(await readFile(join(repoRoot, file), 'utf8'));
    }
  });
});

describe('校验', () => {
  it('数据定义按顺序在内存中发布，版本接在快照之后，问题带位置', async () => {
    const { results } = await session.callJson('check_definitions', { paths: ['candidates/schema-stop.json', 'candidates/schema-stop-v1.json', 'candidates/missing.json'] });
    expect(results.map((result: { published: unknown }) => result.published)).toEqual([{ name: '停靠站点', version: 2 }, null, null]);
    expect(results[0].problems).toEqual([]);
    expect(results[0].compiled).toBeUndefined();
    expect(codes(results[1].problems)).toEqual(['definition.invalid']);
    expect(results[2].problems).toEqual([{ code: 'input.unreadable', level: 'severe', location: { kind: 'input', source: 'candidates/missing.json' }, message: '文件不存在：candidates/missing.json' }]);
    const compiled = await session.callJson('check_definitions', { paths: ['candidates/schema-note.json'], includeCompiled: true });
    expect(compiled.results[0].compiled['x-renderweave-static-schema']).toEqual({ name: '便签', version: 1 });
  });

  it('数据集按快照或候选定义的编译产物校验，问题带字段路径', async () => {
    expect((await session.callJson('check_dataset', { path: 'candidates/dataset-m402.json' })).dataset.problems).toEqual([]);
    const broken = await session.callJson('check_dataset', { path: 'candidates/dataset-m402-broken.json' });
    expect(broken.dataset.problems.map((problem: { code: string; location: unknown }) => [problem.code, problem.location]))
      .toEqual([['dataset.typeMismatch', { kind: 'field', path: 'stops[3].name' }]]);
    const withoutCandidate = await session.callJson('check_dataset', { path: 'candidates/dataset-note.json' });
    expect(codes(withoutCandidate.dataset.problems)).toEqual(['input.staticSchemaNotFound']);
    const withCandidate = await session.callJson('check_dataset', { path: 'candidates/dataset-note.json', definitionPaths: ['candidates/schema-note.json'] });
    expect(withCandidate.definitions[0].published).toEqual({ name: '便签', version: 1 });
    expect(withCandidate.dataset.problems.map((problem: { code: string; location: unknown }) => [problem.code, problem.location]))
      .toEqual([['dataset.constraintViolated', { kind: 'field', path: 'title' }]]);
  });

  it('模板工作副本做静态检查，问题带元素路径；不是模板的文件报为问题', async () => {
    expect(await session.callJson('check_templates', { paths: ['candidates/template-stop.json'] }))
      .toEqual({ templates: [{ path: 'candidates/template-stop.json', name: '站点', replaces: true }], problems: [] });
    const typo = await session.callJson('check_templates', { paths: ['candidates/template-stop-typo.json'] });
    expect(typo.problems.map((problem: { code: string; location: unknown }) => [problem.code, problem.location]))
      .toEqual([['template.unknownVariable', { kind: 'element', path: '站点/名称区/站名' }]]);
    const notTemplate = await session.callJson('check_templates', { paths: ['candidates/schema-note.json'] });
    expect(notTemplate.problems[0].message).toContain('不是模板文档');
    expect(text(await session.call('check_templates', { paths: ['candidates/template-stop.json', 'candidates/template-stop-typo.json'] }))).toContain('工作副本的模板名重复');
  });
});

describe('草稿预览与元素检查', () => {
  it('草稿预览返回 PNG 与问题清单；DPI 超出上限时降低并注明，省略时取上限', async () => {
    const draft = await session.call('render_draft', { request: REQUEST });
    const info = JSON.parse(text(draft));
    expect(info).toEqual({ workingCopies: [], image: { widthPx: 583, heightPx: 130, dpi: 20 }, problems: [] });
    expect(image(draft)!.mimeType).toBe('image/png');
    expect(readPngInfo(Buffer.from(image(draft)!.data, 'base64'))).toMatchObject({ width: 583, height: 130 });

    const high = JSON.parse(text(await session.call('render_draft', { request: { ...REQUEST, output: { width: 740, height: 165, dpi: 600 } } })));
    expect(high).toMatchObject({ requestedDpi: 600, image: { dpi: 68, widthPx: 1981 } });
    const omitted = JSON.parse(text(await session.call('render_draft', { request: { ...REQUEST, output: { width: 90, height: 130 } } })));
    // 草稿照样出图并标出问题：尺寸超出模板的适用范围。
    expect(omitted.image).toEqual({ widthPx: 1063, heightPx: 1535, dpi: 300 });
    expect(codes(omitted.problems)).toContain('render.sizeOutOfRange');
    const wide = JSON.parse(text(await session.call('render_draft', { request: { ...REQUEST, output: { width: 740, height: 165 } } })));
    expect(wide).toMatchObject({ image: { dpi: 68 } });
    expect(wide.requestedDpi).toBeUndefined();
  });

  it('局部预览只返回画板上的一块区域，DPI 按区域大小提高', async () => {
    const zoom = await session.call('render_draft', { request: REQUEST, region: { x: 100, y: 38, width: 25, height: 200 } });
    const info = JSON.parse(text(zoom));
    expect(info.region).toEqual({ x: 100, y: 38, width: 25, height: 127 });
    expect(info.requestedDpi).toBeUndefined();
    expect(info.image).toEqual({ widthPx: mmToPx(125, 300) - mmToPx(100, 300), heightPx: mmToPx(165, 300) - mmToPx(38, 300), dpi: 300 });
    expect(readPngInfo(Buffer.from(image(zoom)!.data, 'base64'))).toMatchObject({ width: info.image.widthPx, height: info.image.heightPx });
    // 区域越大 DPI 越低：整块画板的最长边仍不超过 2000 像素。
    expect(JSON.parse(text(await session.call('render_draft', { request: REQUEST, region: { x: 0, y: 0, width: 740, height: 165 } }))).image)
      .toEqual({ widthPx: 1981, heightPx: 442, dpi: 68 });
    expect(text(await session.call('render_draft', { request: REQUEST, region: { x: 740, y: 0, width: 10, height: 10 } }))).toContain('region 在画板之外');
    expect(text(await session.call('render_draft', { request: { ...REQUEST, output: {} }, region: { x: 0, y: 0, width: 10, height: 10 } }))).toContain('要有 width 与 height');
    expect((await session.call('inspect_layout', { request: REQUEST, region: { x: 0, y: 0, width: 10, height: 10 } })).isError).toBe(true);
  });

  it('工作副本代替被调模板出现在调用方的预览中，已保存的模板不受影响', async () => {
    const saved = await session.call('render_draft', { request: REQUEST });
    const copy = await session.call('render_draft', { request: REQUEST, templates: ['candidates/template-stop.json'] });
    const again = await session.call('render_draft', { request: REQUEST });
    expect(JSON.parse(text(copy)).workingCopies).toEqual([{ path: 'candidates/template-stop.json', name: '站点', replaces: true }]);
    expect(image(copy)!.data).not.toBe(image(saved)!.data);
    expect(image(again)!.data).toBe(image(saved)!.data);
    expect(await session.callJson('read_document', { kind: 'template', name: '站点' })).toEqual(JSON.parse(await readFile(join(m402Dir, 'template-stop.json'), 'utf8')));
  });

  it('数据集可以内联或取自工作目录内的文件，两者只写一个', async () => {
    const dataset = JSON.parse(await readFile(join(root, 'candidates/dataset-m402.json'), 'utf8'));
    const inline = await session.call('render_draft', { request: { ...REQUEST, dataset: { inline: dataset } } });
    const { dataset: _id, ...withoutDataset } = REQUEST;
    const fromFile = await session.call('render_draft', { request: withoutDataset, datasetPath: 'candidates/dataset-m402.json' });
    const saved = await session.call('render_draft', { request: REQUEST });
    expect(image(inline)!.data).toBe(image(saved)!.data);
    expect(image(fromFile)!.data).toBe(image(saved)!.data);
    expect(JSON.parse(text(fromFile)).datasetPath).toBe('candidates/dataset-m402.json');
    expect(text(await session.call('render_draft', { request: REQUEST, datasetPath: 'candidates/dataset-m402.json' }))).toContain('只能写一个');
    const broken = JSON.parse(text(await session.call('render_draft', { request: withoutDataset, datasetPath: 'candidates/dataset-m402-broken.json' })));
    expect(codes(broken.problems)).toContain('dataset.typeMismatch');
    expect(broken.image).not.toBeNull();
  });

  it('元素检查按元素路径返回位置、尺寸、字号、压缩比与是否溢出', async () => {
    const top = await session.callJson('inspect_layout', { request: REQUEST, depth: 0 });
    expect(top.nodes).toEqual([{ path: '标准线路单边', type: 'artboard', x: 0, y: 0, width: 740, height: 165, visible: true, children: 4 }]);
    expect(top.output).toMatchObject({ width: 740, height: 165, dpi: 20 });
    const name = await session.callJson('inspect_layout', { request: REQUEST, elements: ['标准线路单边/站点面板/站点列[5]/名称区/站名'], depth: 0 });
    expect(name.nodes).toHaveLength(1);
    expect(name.nodes[0]).toMatchObject({ type: 'text', visible: true,
      text: { content: '东门', fontSize: 10, writingMode: 'vertical', compression: 1, overflow: false, shrinkGroup: 'stopNames' } });
    const missing = await session.callJson('inspect_layout', { request: REQUEST, elements: ['标准线路单边/站名'] });
    expect(missing.nodes).toEqual([]);
    expect(missing.notFound[0].suggestions[0]).toBe('标准线路单边/站点面板/站点列[1]/名称区/站名');
  });

  it('元素检查给出这些元素上的问题', async () => {
    const dataset = JSON.parse(await readFile(join(root, 'candidates/dataset-m402.json'), 'utf8'));
    dataset.data.stops[0].name = '一个特别特别特别特别特别长的站名';
    const result = await session.callJson('inspect_layout', { request: { ...REQUEST, dataset: { inline: dataset } }, elements: ['标准线路单边/站点面板/站点列[1]'], depth: 3 });
    const name = result.nodes.find((node: { path: string }) => node.path.endsWith('/站名'));
    expect(name.text.compression).toBeLessThan(1);
    expect(result.problems.every((problem: { location: { path: string } }) => problem.location.path.startsWith('标准线路单边/站点面板/站点列[1]'))).toBe(true);
  });
});

describe('局部放大与路径限制', () => {
  it('按像素区域裁切放大，并返回原图尺寸；省略区域时返回整图', async () => {
    const crop = await session.call('view_image', { path: 'sample.png', region: { x: 150, y: 50, width: 100, height: 100 } });
    expect(JSON.parse(text(crop))).toEqual({ original: { width: 200, height: 100 }, region: { x: 150, y: 50, width: 50, height: 50 }, scale: 4, output: { width: 200, height: 200 } });
    expect(readPngInfo(Buffer.from(image(crop)!.data, 'base64'))).toMatchObject({ width: 200, height: 200 });
    expect(JSON.parse(text(await session.call('view_image', { path: 'sample.png' })))).toMatchObject({ region: { x: 0, y: 0, width: 200, height: 100 }, output: { width: 800, height: 400 } });
    expect(text(await session.call('view_image', { path: 'notes.txt' }))).toBe('无法解码图片：notes.txt');
  });

  it('工作目录外的路径一律拒绝：上级目录、绝对路径、目录联接与不存在的文件', async () => {
    for (const path of ['../outside/secret.json', join(outside, 'secret.json'), 'link/secret.json']) {
      const viewed = await session.call('view_image', { path });
      expect(viewed.isError).toBe(true);
      expect(text(viewed)).toContain('只能读取工作目录内的文件');
      const checked = await session.callJson('check_templates', { paths: [path] });
      expect(checked.problems[0].message).toContain('只能读取工作目录内的文件');
      expect(text(await session.call('render_draft', { request: REQUEST, templates: [path] }))).toContain('只能读取工作目录内的文件');
    }
    expect(text(await session.call('view_image', { path: join(root, 'sample.png') }))).toContain('"original"');
    expect(text(await session.call('view_image', { path: 'candidates' }))).toBe('不是文件：candidates');
    expect(text(await session.call('check_dataset', { path: 'nothing.json' }))).toContain('文件不存在：nothing.json');
  });
});

describe('交回前核对成果', () => {
  it('启动时没有给出本轮任务，check_outcome 作为工具错误返回', async () => {
    const result = await session.call('check_outcome', {});
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('--outcome-context');
  });

  it('按交回后的同一套规则核对：待确认项的路径对不上时不合格，改对后合格；不写任何文件', async () => {
    const dir = join(base, 'handoff');
    await mkdir(join(dir, 'candidates'), { recursive: true });
    await writeFile(join(dir, 'candidates/schema-note.json'), JSON.stringify(NOTE));
    const outcome = {
      candidates: ['candidates/schema-note.json'],
      locations: [{ file: 'candidates/schema-note.json', path: 'titel', where: '顶部的标题' }],
      pending: [{ file: 'candidates/schema-note.json', path: 'subtitle', reason: 'inferred', note: '图上没有副标题' }],
      notes: '便签只有标题。',
    };
    await writeFile(join(dir, 'outcome.json'), JSON.stringify(outcome));
    const contextFile = join(base, 'outcome-context.json');
    await writeFile(contextFile, JSON.stringify({ task: 'definition-extraction' }));
    const handoff = startMcp(['--workspace', m402Dir, '--resources', resourcesDir, '--root', dir, '--outcome-context', contextFile]);

    const first = await handoff.callJson('check_outcome', {});
    expect(first.verdict).toBe('unqualified');
    expect(first.problems.map((problem: { level: string; location: { source: string } }) => [problem.level, problem.location.source]))
      .toEqual([['severe', 'outcome.json#pending[1]'], ['hint', 'outcome.json#locations[1]']]);
    expect(first.problems[0].message).toContain('没有字段 subtitle');
    expect(first.candidates).toEqual([{ path: 'candidates/schema-note.json', kind: 'definition', name: '便签', published: { name: '便签', version: 1 }, problems: [] }]);

    await writeFile(join(dir, 'outcome.json'), JSON.stringify({ ...outcome, locations: [{ ...outcome.locations[0], path: 'title' }], pending: [] }));
    const unchanged = await fingerprint(dir);
    expect(await handoff.callJson('check_outcome', {})).toMatchObject({ verdict: 'qualified', problems: [] });
    expect([...(await fingerprint(dir)).entries()]).toEqual([...unchanged.entries()]);
    expect(await handoff.close()).toBe(0);
  });

  it('上下文文件读不了或不合规时是用法错误', async () => {
    const stderr: string[] = [];
    const io = { stdout: () => {}, stderr: (text: string) => stderr.push(text), stdin: process.stdin };
    const args = ['mcp', '--workspace', m402Dir, '--resources', resourcesDir, '--root', root, '--outcome-context'];
    const unknownTask = join(base, 'context-unknown-task.json');
    await writeFile(unknownTask, JSON.stringify({ task: 'ocr' }));
    const extraKey = join(base, 'context-extra-key.json');
    await writeFile(extraKey, JSON.stringify({ task: 'template-design', request: { template: '标准线路单边' }, dataset: 'ds-m402' }));
    expect(await runCli([...args, join(base, 'nope.json')], io)).toBe(2);
    expect(await runCli([...args, unknownTask], io)).toBe(2);
    expect(await runCli([...args, extraKey], io)).toBe(2);
    expect(stderr.filter((line) => line.includes('成果核对的上下文'))).toHaveLength(3);
  });
});

describe('会话结束', () => {
  it('读完标准输入后正常退出；工作区、资源仓库与工作目录都没有变化；每次调用都记入日志', async () => {
    expect(await session.close()).toBe(0);
    const after = await fingerprint(m402Dir, resourcesDir, root, outside);
    expect([...after.entries()]).toEqual([...before.entries()]);
    const entries = (await readFile(logFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(entries.length).toBeGreaterThan(30);
    expect(entries[0]).toMatchObject({ tool: expect.any(String), ms: expect.any(Number), isError: expect.any(Boolean) });
  });
});

describe('命令行', () => {
  it('工作区在启动时读入为快照，之后的改动不影响本轮', async () => {
    const workspace = join(base, 'snapshot');
    await cp(singleTextDir, workspace, { recursive: true });
    const snapshot = startMcp(['--workspace', workspace, '--resources', resourcesDir, '--root', root]);
    const listed = await snapshot.callJson('list_documents');
    await rm(join(workspace, 'template-greeting.json'));
    expect(await snapshot.callJson('list_documents')).toEqual(listed);
    expect(listed.templates).toHaveLength(1);
    expect(await snapshot.close()).toBe(0);
  });

  it('--tools 只开放列出的工具；缺少参数、目录不存在或工具名不对时是用法错误', async () => {
    const limited = startMcp(['--workspace', m402Dir, '--resources', resourcesDir, '--root', root, '--tools', 'render_draft,view_image']);
    expect((await limited.request('tools/list')).result.tools.map((tool: { name: string }) => tool.name)).toEqual(['render_draft', 'view_image']);
    expect((await limited.request('tools/call', { name: 'list_documents', arguments: {} })).error.code).toBe(-32602);
    expect(await limited.close()).toBe(0);

    const stderr: string[] = [];
    const io = { stdout: () => {}, stderr: (text: string) => stderr.push(text), stdin: process.stdin };
    expect(await runCli(['mcp', '--workspace', m402Dir, '--resources', resourcesDir], io)).toBe(2);
    expect(await runCli(['mcp', '--workspace', m402Dir, '--resources', resourcesDir, '--root', join(base, 'nope')], io)).toBe(2);
    expect(await runCli(['mcp', '--workspace', join(base, 'nope'), '--resources', resourcesDir, '--root', root], io)).toBe(2);
    expect(await runCli(['mcp', '--workspace', m402Dir, '--resources', resourcesDir, '--root', root, '--tools', 'save_template'], io)).toBe(2);
    expect(stderr.join('')).toContain('没有工具：save_template');
  });
});
