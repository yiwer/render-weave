import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { deliverBatch, readOutputRecord, replayOutputRecord, initializeResourceStore, importResources, openVersionedResourceStore, loadWorkspace,
  render, type VersionedResourceStore, type Workspace, type RenderOptions } from '../src/index.js';
import { m402Dir, resourcesDir, repoRoot, withTemplate, textLab, textLabRequest } from './support/fixtures.js';

const mediaDir = join(repoRoot, 'fixtures/workspaces/record-media');
const json = async (file: string) => JSON.parse(await fs.readFile(file, 'utf8'));
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const batch = (single: Record<string, unknown>) => { const { template, mode, ...item } = single; return { template, mode, items: [{ id: 'record', ...item }] }; };
let root: string, store: VersionedResourceStore, m402: Workspace, media: Workspace, request: any, mediaRequest: any, options: RenderOptions;
let sequence = 0;
const target = () => join(root, `out-${++sequence}`);
beforeAll(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'renderweave-closure-'));
  const dir = join(root, 'resources'), extra = join(root, 'extra');
  expect((await initializeResourceStore(dir)).problems).toEqual([]);
  expect((await importResources({ sourceDir: resourcesDir, dir })).problems).toEqual([]);
  await fs.mkdir(extra);
  await fs.copyFile(join(resourcesDir, 'font-subsets/TestSubset-Regular.otf'), join(extra, 'subset.otf'));
  await fs.copyFile(join(mediaDir, 'text.svg'), join(extra, 'text.svg'));
  await fs.writeFile(join(extra, 'resources.json'), JSON.stringify({ resources: [
    { id: 'subset', kind: 'font', file: 'subset.otf' }, { id: 'record-text-svg', kind: 'image', file: 'text.svg' },
  ] }));
  expect((await importResources({ sourceDir: extra, dir })).problems).toEqual([]);
  store = (await openVersionedResourceStore(dir)).store!;
  m402 = await loadWorkspace({ dir: m402Dir, resourcesDir: dir });
  media = await loadWorkspace({ dir: mediaDir, resourcesDir: dir });
  request = await json(join(m402Dir, 'render-request-m402.json'));
  mediaRequest = await json(join(mediaDir, 'render-request.json')); options = await json(join(mediaDir, 'options.json'));
  for (const [name, workspace, single, renderOptions] of [['m402', m402, request, undefined], ['media', media, mediaRequest, options]] as const) {
    // 单项批次的记录目录移到固定位置，后续用例直接把它当作独立记录。
    const result = await deliverBatch({ workspace, resources: store, request: batch(single), outDir: join(root, `${name}-batch`), renderOptions });
    expect(result.problems).toEqual([]); expect(result.items[0]?.status).toBe('delivered');
    await fs.rename(join(root, `${name}-batch`, '0001'), join(root, name));
    const direct = await render(workspace, single, renderOptions);
    expect(await fs.readFile(join(root, name, 'image.png'))).toEqual(Buffer.from(direct.image!.bytes));
    expect(await json(join(root, name, 'problems.json'))).toEqual(direct.problems);
    expect(await json(join(root, name, 'layout.json'))).toEqual(direct.layout);
  }
});
afterAll(async () => {
  if (!resolve(root).startsWith(join(resolve(tmpdir()), 'renderweave-closure-'))) throw new Error('测试清理路径越界');
  await fs.rm(root, { recursive: true, force: true });
});
async function copyRecord(name = 'm402'): Promise<string> { const dir = target(); await fs.cp(join(root, name), dir, { recursive: true }); return dir; }
async function changeInput(dir: string, change: (input: any) => void) {
  const input = await json(join(dir, 'input.json')); change(input);
  const bytes = Buffer.from(JSON.stringify(input)); await fs.writeFile(join(dir, 'input.json'), bytes);
  const manifest = await json(join(dir, 'record.json'));
  Object.assign(manifest.files.find((f: any) => f.file === 'input.json'), { sha256: hash(bytes), byteLength: bytes.length });
  await fs.writeFile(join(dir, 'record.json'), JSON.stringify(manifest));
}
it.each(['m402', 'media'])('%s 独立复制并移开原记录及仓库后，公开重放得到相同成果', async (name) => {
  const dir = await copyRecord(name), out = target();
  const original = join(root, name), hidden = join(root, `${name}-hidden`), resources = join(root, 'resources'), moved = join(root, 'resources-hidden');
  // 两端均为已验证的测试根目录内固定子路径。
  for (const p of [original, hidden, resources, moved]) { const rel = relative(root, p); expect(rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)).toBe(true); }
  await fs.rename(original, hidden); await fs.rename(resources, moved);
  try {
    const result = await replayOutputRecord({ dir, outDir: out }); expect(result.replayed).toBeDefined();
    for (const file of ['image.png', 'problems.json', 'layout.json']) expect(await fs.readFile(join(out, file))).toEqual(await fs.readFile(join(dir, file)));
  } finally { await fs.rename(hidden, original); await fs.rename(moved, resources); }
});
it('M402 收齐五个模板、引用定义和基本类型包装；只保存实际依赖的资源', async () => {
  const saved = await json(join(root, 'm402/input.json'));
  expect(saved.documents.templates).toHaveLength(5);
  expect(saved.documents.staticSchemas.map((s: any) => s.ref.name)).toEqual(expect.arrayContaining(['线路牌', '停靠站点', '单值·文本', '单值·时刻']));
  const read = await readOutputRecord({ dir: join(root, 'm402') }); expect(read.problems).toEqual([]);
  expect(read.record?.resources.some((r) => r.id === 'route-no-m402' && r.state === 'available' && r.kind === 'image')).toBe(true);
  expect(read.record?.resources.some((r) => r.id === 'test-quadrants-png')).toBe(false);
});
it('SVG 字体、后备顺序及缺失状态固定；缺字替代提示真实保留', async () => {
  const saved = await json(join(root, 'media/input.json'));
  expect(saved.options).toEqual(options);
  const problems = await json(join(root, 'media/problems.json'));
  expect(problems).toEqual([expect.objectContaining({ code: 'text.glyphFallback', level: 'hint' })]);
  const read = await readOutputRecord({ dir: join(root, 'media') }); expect(read.problems).toEqual([]);
  expect(read.record?.resources).toEqual(expect.arrayContaining([{ id: 'missing-fallback', state: 'missing' }, { id: 'missing-svg-font', state: 'missing' }]));
  for (const id of ['test-quadrants-png', 'test-quadrants-jpg', 'test-quadrants-webp', 'record-text-svg', 'subset', 'font-hei-regular']) expect(read.record?.resources.some((r) => r.id === id && r.state === 'available')).toBe(true);
});
it.each(['template', 'definition', 'compiled', 'builtin'])('删除嵌套 %s，即使更新 input 哈希也拒绝完整性读取', async (part) => {
  const dir = await copyRecord();
  await changeInput(dir, (input) => {
    if (part === 'template') input.documents.templates.splice(1, 1);
    else if (part === 'builtin') input.documents.staticSchemas = input.documents.staticSchemas.filter((s: any) => !s.ref.name.startsWith('单值·'));
    else delete input.documents.staticSchemas.find((s: any) => s.ref.name === '停靠站点')[part];
  });
  expect((await readOutputRecord({ dir })).record).toBeUndefined();
  expect((await replayOutputRecord({ dir, outDir: target() })).replayed).toBeUndefined();
});
it.each(['template', 'definition', 'compiled'])('篡改嵌套 %s 未更新哈希即拒绝', async (part) => {
  const dir = await copyRecord(), input = await json(join(dir, 'input.json'));
  if (part === 'template') input.documents.templates[1].document.artboard.fill = '#FF0000';
  else input.documents.staticSchemas.find((s: any) => s.ref.name === '停靠站点')[part].changed = true;
  await fs.writeFile(join(dir, 'input.json'), JSON.stringify(input));
  expect((await readOutputRecord({ dir })).problems[0]?.code).toBe('record.integrityMismatch');
});
it.each(['image', 'font'])('图片/字体资源 %s 删除或改写均不能重放', async (kind) => {
  for (const remove of [true, false]) {
    const dir = await copyRecord('media'), manifest = await json(join(dir, 'record.json'));
    const file = manifest.resources.find((r: any) => r.kind === kind).file;
    if (remove) await fs.unlink(join(dir, file)); else await fs.appendFile(join(dir, file), 'damage');
    expect((await replayOutputRecord({ dir, outDir: target() })).replayed).toBeUndefined();
  }
});
it('不完整模板/引用定义、循环调用与版本不一致不交付', async () => {
  const child = m402.templates[1]!;
  const variants = [
    { ...m402, templates: m402.templates.filter((t) => t !== child) },
    { ...m402, staticSchemas: m402.staticSchemas.filter((s) => s.ref.name !== '停靠站点') },
    withTemplate(m402, child.name, (d) => { d.base.version = 2; }),
    withTemplate(m402, request.template, (d) => d.artboard.children.push({ type: 'call', name: '自调', data: 'current', template: request.template, args: {} })),
  ];
  for (const workspace of variants) expect((await deliverBatch({ workspace, resources: store, request: batch(request), outDir: target() })).directory).toBeUndefined();
});
it('图片实参、派生分支及隐藏状态资源都冻结，普通文字中的 res: 不当作图片', async () => {
  let workspace = await textLab([], { children: [{ type: 'call', name: '调用', template: '图片子模板', data: 'current', args: { image: { value: 'res:icon-metro' } },
    states: { by: { var: 'label' }, cases: { hidden: { args: { image: { value: 'res:icon-hospital' } } } } }, place: { width: { fixed: 10 }, height: { fixed: 10 } } }] }, {
    parameters: [{ name: 'label', displayName: '标签', type: 'text', visibility: 'public', default: 'res:ordinary-text' },
      { name: 'image', displayName: '图', type: 'image', visibility: 'public', default: 'res:landmark-1' }],
    derived: [{ name: 'selected', displayName: '选择', type: 'image', op: 'branch', branches: [{ when: { left: { var: 'label' }, op: 'eq', right: { value: 'x' } }, then: { value: 'res:landmark-2' } }], otherwise: { value: 'res:landmark-3' } }],
  });
  const child = { dslVersion: 'renderweave-template/1', name: '图片子模板', base: { name: '文字实验', version: 1 },
    parameters: [{ name: 'image', displayName: '图', type: 'image', visibility: 'public' }],
    artboard: { sizeRange: { width: { min: 1, max: 100 }, height: { min: 1, max: 100 } }, children: [
      { type: 'image', name: '图', source: { var: 'image' }, place: { width: 'fill', height: 'fill' } },
      { type: 'image', name: '隐藏', visible: false, source: 'res:landmark-4' },
    ] } };
  workspace = { ...workspace, templates: [...workspace.templates, { name: child.name, document: child }] };
  const out = target(); const result = await deliverBatch({ workspace, resources: store, request: batch(textLabRequest({}, 20, 20, 120, { image: 'res:route-no-m402' })), outDir: out, renderOptions: { fallbackFonts: [], svgFonts: [] } });
  expect(result.problems).toEqual([]); expect(result.items[0]?.status).toBe('delivered');
  const ids = (await readOutputRecord({ dir: join(out, '0001') })).record?.resources.map((r) => r.id);
  expect(ids).toEqual(['icon-hospital', 'icon-metro', 'landmark-1', 'landmark-2', 'landmark-3', 'landmark-4', 'route-no-m402']);
  expect((await replayOutputRecord({ dir: join(out, '0001'), outDir: target() })).replayed).toBeDefined();
});
it('列表图片通过单值包装传入子模板，片段及隐藏状态字体也归档', async () => {
  const workspace = await textLab([{ name: 'pictures', displayName: '图片列表', type: 'list', items: { type: 'image' } }], { children: [
    { type: 'loop', name: '图片列', list: { var: 'pictures' }, template: '图片单值', args: {},
      itemLayout: { direction: 'row', widths: 'equal' }, place: { left: 0, top: 0, width: { fixed: 40 }, height: { fixed: 10 } } },
    { type: 'text', name: '文字', font: 'res:font-hei-regular', fontSize: 5, content: [{ text: '甲', font: 'res:font-hei-bold' }],
      visible: false, states: { by: { var: 'label' }, cases: { hidden: { font: 'res:font-hei-heavy', content: [{ text: '乙', font: 'res:font-hei-medium' }] } } } },
  ] }, { parameters: [{ name: 'label', displayName: '状态', visibility: 'public', type: 'text', default: 'normal' }] });
  const child = { dslVersion: 'renderweave-template/1', name: '图片单值', base: { name: '单值·图片', version: 1 },
    artboard: { sizeRange: { width: { min: 1, max: 100 }, height: { min: 1, max: 100 } }, children: [
      { type: 'image', name: '图', source: { var: 'value' }, place: { width: 'fill', height: 'fill' } },
    ] } };
  const out = target();
  const result = await deliverBatch({ workspace: { ...workspace, templates: [...workspace.templates, { name: child.name, document: child }] }, resources: store,
    request: batch(textLabRequest({ pictures: ['res:test-quadrants-png', 'res:test-quadrants-webp'] }, 40, 20)), outDir: out, renderOptions: { fallbackFonts: [], svgFonts: [] } });
  expect(result.problems).toEqual([]); expect(result.items[0]?.status).toBe('delivered');
  const ids = (await readOutputRecord({ dir: join(out, '0001') })).record?.resources.map((r) => r.id);
  expect(ids).toEqual(['font-hei-bold', 'font-hei-heavy', 'font-hei-medium', 'font-hei-regular', 'test-quadrants-png', 'test-quadrants-webp']);
  expect((await replayOutputRecord({ dir: join(out, '0001'), outDir: target() })).replayed).toBeDefined();
});
it('子模板的另一个基准版本虽存在，仍拒绝与调用数据版本错配', async () => {
  const changed = withTemplate(m402, '站点', (d) => { d.base.version = 2; });
  const entry = structuredClone(m402.staticSchemas.find((s) => s.ref.name === '停靠站点')!);
  const version2 = { ...entry, ref: { name: '停靠站点', version: 2 } };
  (version2.definition as any).version = 2; version2.compiled!['x-renderweave-static-schema'] = version2.ref;
  const result = await deliverBatch({ workspace: { ...changed, staticSchemas: [...changed.staticSchemas, version2] }, resources: store, request: batch(request), outDir: target() });
  expect(result.items[0]?.status).toBe('failed');
  expect(result.items[0]?.problems.some((p) => p.code === 'template.loopBaseMismatch' || p.code === 'template.callBaseMismatch')).toBe(true);
});
