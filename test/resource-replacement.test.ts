import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyResourceReplacement, checkResourceReplacement, importResources, initializeResourceStore,
  loadWorkspace, openVersionedResourceStore, ProblemCodes, render, type ResourceReplacementCheck, type RenderOptions } from '../src/index.js';
import { runCli } from '../src/cli.js';
import { copyWorkspaceFixture, m402Dir, resourcesDir } from './support/fixtures.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, rename: vi.fn(actual.rename), open: vi.fn(actual.open), rmdir: vi.fn(actual.rmdir) };
});
let root: string, dir: string, workspaceDir: string, file: string;
const originalBytes = Uint8Array.from([1, 2, 3]);
const newBytes = Uint8Array.from([4, 5, 6]);
const context = () => ({ dir, workspaceDir, file });
const store = async () => (await openVersionedResourceStore(dir)).store!;
const json = (path: string, value: unknown) => fs.writeFile(path, JSON.stringify(value));
const readJson = async (path: string) => JSON.parse(await fs.readFile(path, 'utf8'));
const check = async () => {
  const result = await checkResourceReplacement({ ...context(), id: 'photo', kind: 'image' });
  expect(result.problems).toEqual([]);
  expect(result.check).toBeDefined();
  return result.check!;
};
const apply = (checked: unknown) => applyResourceReplacement({ ...context(), check: checked });
const template = (name: string, children: unknown[], extra = {}) => ({
  dslVersion: 'renderweave-template/1', name, base: { name: '空数据定义', version: 1 }, ...extra,
  artboard: { sizeRange: { width: { min: 10, max: 200 }, height: { min: 10, max: 200 } }, layout: { mode: 'free' }, children },
});
const place = { width: { fixed: 20 }, height: { fixed: 20 } };
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'renderweave-replace-'));
  dir = join(root, 'resources'); workspaceDir = join(root, 'workspace'); file = join(root, 'replacement.bin');
  const source = join(root, 'source');
  await fs.mkdir(source); await fs.mkdir(workspaceDir);
  await fs.writeFile(join(source, 'content.bin'), originalBytes);
  await json(join(source, 'resources.json'), { resources: [{ id: 'photo', kind: 'image', file: 'content.bin' }, { id: 'font', kind: 'font', file: 'content.bin' }] });
  expect((await initializeResourceStore(dir)).problems).toEqual([]);
  expect((await importResources({ dir, sourceDir: source })).problems).toEqual([]);
  await fs.writeFile(file, newBytes);
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (!resolve(root).startsWith(join(resolve(tmpdir()), 'renderweave-replace-'))) throw new Error('测试清理路径越界');
  await fs.rm(root, { recursive: true, force: true });
});

describe('检查与应用资源替换', () => {
  it('替换已提交后释放目录约束失败仍返回新版本，清理问题作为提示', async () => {
    const checked = await check();
    vi.mocked(fs.rmdir).mockRejectedValueOnce(Object.assign(new Error('模拟目录释放失败'), { code: 'EBUSY' }));
    const result = await apply(checked);
    expect(result.replaced?.version).toBe(2);
    expect(result.problems).toEqual([expect.objectContaining({ code: ProblemCodes.resourceWriteFailed, level: 'hint' })]);
    expect(await (await store()).read('photo', 2)).toEqual(newBytes);
  });
  it('检查只读；零引用也需版本检查，同字节再次替换产生 v3', async () => {
    const before = await fs.readFile(join(dir, 'resources.json'));
    const opened = await store();
    const pinned = opened.pin();
    const report = await check();
    expect(report.impact.references).toEqual([]);
    expect(report.impact.scope).toContain('不覆盖其他工作区');
    expect(await fs.readFile(join(dir, 'resources.json'))).toEqual(before);
    expect((await apply(report)).replaced).toMatchObject({ id: 'photo', kind: 'image', version: 2 });
    expect(await (await store()).read('photo', 1)).toEqual(originalBytes);
    expect(await (await store()).read('photo', 2)).toEqual(newBytes);
    expect(await pinned.repository!.read('photo')).toEqual(originalBytes);
    expect(opened.get('photo')?.version).toBe(1);
    expect((await apply(report)).problems[0]?.code).toBe(ProblemCodes.resourceReplacementStale);
    const fresh = await check();
    expect((await apply(fresh)).replaced).toMatchObject({ version: 3, sha256: fresh.resource.sha256 });
    expect(await (await store()).read('photo', 3)).toEqual(newBytes);
  });

  it('完整分类直接引用，包含隐藏与状态分支，不误报普通文本和码图内容', async () => {
    await json(join(workspaceDir, 'child.json'), template('Child', [], { parameters: [{ name: 'logo', displayName: '图片', visibility: 'public', type: 'image', default: 'res:photo' }] }));
    await json(join(workspaceDir, 'main.json'), template('Main', [
      { type: 'image', name: 'Image', source: 'res:photo', visible: false, place, states: { by: { var: 'flag' }, cases: { true: { source: 'res:photo' } } } },
      { type: 'call', name: 'Call', template: 'Child', place, args: { logo: { value: 'res:photo' } } },
      { type: 'text', name: 'Text', font: 'res:font', fontSize: 3, content: [{ text: 'res:photo', font: 'res:font' }], place },
      { type: 'qrcode', name: 'Code', content: 'res:photo', place },
    ], { parameters: [{ name: 'logo', displayName: '图片', visibility: 'public', type: 'image', default: 'res:photo' }, { name: 'literal', displayName: '文本', visibility: 'public', type: 'text', default: 'res:photo' }, { name: 'flag', displayName: '开关', visibility: 'public', type: 'boolean', default: true }],
      derived: [{ name: 'picture', displayName: '派生图片', type: 'image', op: 'branch', branches: [{ when: { left: { value: true }, op: 'eq', right: { value: true } }, then: { value: 'res:photo' } }], otherwise: { value: 'res:photo' } }] }));
    await json(join(workspaceDir, 'compiled.json'), { 'x-renderweave-static-schema': { name: 'Data', version: 1 }, type: 'object', properties: {
      text: { type: 'string' }, logo: { type: 'string', 'x-renderweave-type': 'image' },
      stops: { type: 'array', items: { type: 'object', properties: { photo: { type: 'string', 'x-renderweave-type': 'image' } } } },
      pictures: { type: 'array', items: { type: 'string', 'x-renderweave-type': 'image' } },
    } });
    await json(join(workspaceDir, 'data.json'), { dataset: { id: 'data', staticSchema: { name: 'Data', version: 1 } }, data: { text: 'res:photo', logo: 'res:photo', stops: [{ photo: 'res:photo' }], pictures: ['res:photo'] } });
    const report = await check();
    expect(report.impact.references.map((item) => item.kind).sort()).toEqual(['parameterDefault', 'parameterDefault', 'derivedValue', 'derivedValue', 'templateFixed', 'stateStyle', 'callArgument', 'datasetImage', 'datasetImage', 'datasetImage'].sort());
    expect(report.impact.references.filter((item) => item.kind === 'datasetImage').map((item) => item.path)).toEqual(['/data/logo', '/data/stops/0/photo', '/data/pictures/0']);
    const fonts = await checkResourceReplacement({ ...context(), id: 'font', kind: 'font', renderOptions: { fallbackFonts: ['font'], svgFonts: ['font'] } });
    expect(fonts.problems).toEqual([]);
    expect(fonts.check!.impact.references).toHaveLength(2);
    expect(fonts.check!.impact.configuration.map((item) => item.kind)).toEqual(['fallbackFonts', 'svgFonts']);
    expect((await applyResourceReplacement({ ...context(), check: fonts.check, renderOptions: { fallbackFonts: ['font'], svgFonts: ['font'] } })).replaced?.kind).toBe('font');
  });

  it.each(['edit', 'add', 'delete', 'format', 'options', 'candidate', 'workspace', 'repository'])('拒绝过期上下文：%s', async (change) => {
    const document = join(workspaceDir, 'request.json');
    await json(document, { value: 1 });
    const report = await check();
    if (change === 'edit') await json(document, { value: 2 });
    if (change === 'add') await json(join(workspaceDir, 'another.json'), {});
    if (change === 'delete') await fs.unlink(document);
    if (change === 'format') await fs.appendFile(document, '\n');
    if (change === 'candidate') await fs.writeFile(file, originalBytes);
    if (change === 'workspace') { workspaceDir = join(root, 'other-workspace'); await fs.mkdir(workspaceDir); await json(join(workspaceDir, 'request.json'), { value: 1 }); }
    if (change === 'repository') { const copied = join(root, 'copy'); await fs.cp(dir, copied, { recursive: true }); dir = copied; }
    const result = await applyResourceReplacement({ ...context(), check: report, ...(change === 'options' ? { renderOptions: { fallbackFonts: [], svgFonts: [] } } : {}) });
    expect(result.replaced).toBeUndefined();
    expect(result.problems[0]?.code).toBe(ProblemCodes.resourceReplacementStale);
    expect((await store()).get('photo')?.version).toBe(1);
  });

  it.each([undefined, {}, { format: 'future' }, { resource: { version: 1 } }])('缺少检查报告或必要条件时拒绝：%j', async (report) => {
    expect((await apply(report)).problems[0]?.code).toBe(ProblemCodes.resourceReplacementInvalid);
    expect((await store()).get('photo')?.version).toBe(1);
  });

  it('改变种类、不存在资源、不可读候选、损坏当前内容均拒绝', async () => {
    expect((await checkResourceReplacement({ ...context(), id: 'photo', kind: 'font' })).problems[0]?.code).toBe(ProblemCodes.resourceKindMismatch);
    expect((await checkResourceReplacement({ ...context(), id: 'missing', kind: 'image' })).problems[0]?.code).toBe(ProblemCodes.resourceNotFound);
    expect((await checkResourceReplacement({ ...context(), id: 'photo', kind: 'image', file: root })).problems[0]?.code).toBe(ProblemCodes.resourceUnreadable);
    const report = await check();
    const edited = structuredClone(report); (edited.resource as { kind: string }).kind = 'font';
    expect((await apply(edited)).problems[0]?.code).toBe(ProblemCodes.resourceKindMismatch);
    const manifest = await readJson(join(dir, 'resources.json'));
    await fs.writeFile(join(dir, manifest.resources[0].versions[0].file), 'damaged');
    expect((await apply(report)).problems[0]?.code).toBe(ProblemCodes.resourceIntegrityMismatch);
    expect((await checkResourceReplacement({ ...context(), id: 'photo', kind: 'image' })).problems[0]?.code).toBe(ProblemCodes.resourceIntegrityMismatch);
  });

  it('不完整工作区不能给出空引用的成功报告', async () => {
    await json(join(workspaceDir, 'data.json'), { dataset: { id: 'data', staticSchema: { name: 'Missing', version: 1 } }, data: {} });
    const result = await checkResourceReplacement({ ...context(), id: 'photo', kind: 'image' });
    expect(result.check).toBeUndefined(); expect(result.problems[0]?.level).toBe('severe');
  });

  it('非法字体配置不能静默采用默认值生成报告或应用替换', async () => {
    const report = await check();
    for (const invalid of [null, { svgFonts: null }, { fallbackFonts: [2] }, { other: [] }]) {
      const renderOptions = invalid as unknown as RenderOptions;
      const result = await checkResourceReplacement({ ...context(), id: 'photo', kind: 'image', renderOptions });
      expect(result.check).toBeUndefined();
      expect(result.problems[0]?.code).toBe(ProblemCodes.inputUnreadable);
      expect((await applyResourceReplacement({ ...context(), check: report, renderOptions })).replaced).toBeUndefined();
    }
    expect((await store()).get('photo')?.version).toBe(1);
  });

  it('同一 v1 的并发应用只有一个成功，旧版仍可读', async () => {
    const report = await check();
    const results = await Promise.all([apply(report), apply(report)]);
    expect(results.filter((result) => result.replaced)).toHaveLength(1);
    for (const issue of results.flatMap((result) => result.problems)) expect([ProblemCodes.resourceStoreBusy, ProblemCodes.resourceReplacementStale]).toContain(issue.code);
    expect((await store()).get('photo')?.version).toBe(2);
    expect(await (await store()).read('photo', 1)).toEqual(originalBytes);
  });

  it('发布 I/O 失败保留 v1，清除本次内容，原报告可重试', async () => {
    const report = await check();
    const before = await fs.readFile(join(dir, 'resources.json'));
    const files = await fs.readdir(join(dir, 'objects'));
    vi.mocked(fs.rename).mockRejectedValueOnce(new Error('EIO: commit failed'));
    const result = await apply(report);
    expect(result.replaced).toBeUndefined(); expect(result.problems[0]?.code).toBe(ProblemCodes.resourceWriteFailed);
    expect(await fs.readFile(join(dir, 'resources.json'))).toEqual(before);
    expect(await fs.readdir(join(dir, 'objects'))).toEqual(files);
    expect(await (await store()).read('photo', 1)).toEqual(originalBytes);
    expect((await apply(report)).replaced?.version).toBe(2);
  });

  it('内容落盘期间工作区变更会撤回新文件，不发布新版本', async () => {
    const report = await check();
    const files = await fs.readdir(join(dir, 'objects'));
    const actual = await vi.importActual<typeof fs>('node:fs/promises');
    vi.mocked(fs.open).mockImplementationOnce(async (path, flags, mode) => {
      await json(join(workspaceDir, 'new.json'), {});
      return actual.open(path, flags, mode);
    });
    expect((await apply(report)).problems[0]?.code).toBe(ProblemCodes.resourceReplacementStale);
    expect((await store()).get('photo')?.version).toBe(1);
    expect(await fs.readdir(join(dir, 'objects'))).toEqual(files);
  });

  it.runIf(process.platform === 'win32')('清单替换短暂 EPERM 后重新核对工作区，过期报告不能趁重试提交', async () => {
    const report = await check();
    const before = await fs.readFile(join(dir, 'resources.json'));
    vi.mocked(fs.rename).mockImplementationOnce(async () => {
      await json(join(workspaceDir, 'changed.json'), {});
      throw Object.assign(new Error('temporary rename denial'), { code: 'EPERM' });
    });
    const result = await apply(report);
    expect(result.replaced).toBeUndefined();
    expect(result.problems[0]?.code).toBe(ProblemCodes.resourceReplacementStale);
    expect(await fs.readFile(join(dir, 'resources.json'))).toEqual(before);
  });
});

describe('真实图片、字体与 CLI 验收', () => {
  it('CLI 检查/应用/查询旧版；图片和字体替换均改变当前出图，固定 v1 逐字节还原', async () => {
    dir = join(root, 'complete');
    await initializeResourceStore(dir);
    expect((await importResources({ dir, sourceDir: resourcesDir })).problems).toEqual([]);
    await copyWorkspaceFixture(m402Dir, workspaceDir);
    const initial = await store();
    const fixed = initial.pin();
    const requestFile = join(workspaceDir, 'render-request-m402.json');
    const request = await readJson(requestFile);
    const baseline = await render(await loadWorkspace({ dir: workspaceDir, resourcesDir: dir }), request);
    expect(baseline.problems).toEqual([]);
    const originalManifest = await readJson(join(resourcesDir, 'resources.json'));
    const resourceFile = (id: string) => join(resourcesDir, originalManifest.resources.find((item: { id: string }) => item.id === id).file);
    const errors: string[] = [], output: string[] = [];
    const io = { stdout: (value: string) => output.push(value), stderr: (value: string) => errors.push(value) };
    let previousHash = baseline.image!.bytes;
    for (const [id, kind, replacement] of [['icon-metro', 'image', 'icon-hospital'], ['font-hei-medium', 'font', 'font-hei-heavy']]) {
      const reportFile = join(root, `${id}-check.json`);
      const candidate = resourceFile(replacement!);
      expect(await runCli(['resources-check', '--resources', dir, '--workspace', workspaceDir, '--id', id!, '--kind', kind!, '--file', candidate, '--out', reportFile], io)).toBe(0);
      const report = await readJson(reportFile) as ResourceReplacementCheck;
      expect(report.resource.version).toBe(1);
      expect(report.impact.references.length).toBeGreaterThan(0);
      if (kind === 'font') expect(report.impact.configuration).toHaveLength(2);
      expect(await runCli(['resources-apply', '--resources', dir, '--workspace', workspaceDir, '--file', candidate, '--check', reportFile], io)).toBe(0);
      output.length = 0;
      expect(await runCli(['resources-get', '--resources', dir, '--id', id!, '--version', '1'], io)).toBe(0);
      expect(JSON.parse(output.join('')).sha256).toBe(initial.get(id!)!.sha256);
      const workspace = await loadWorkspace({ dir: workspaceDir, resourcesDir: dir });
      const current = await render(workspace, request);
      expect(current.problems).toEqual([]);
      expect(Buffer.from(current.image!.bytes).equals(Buffer.from(previousHash))).toBe(false);
      previousHash = current.image!.bytes;
      const historical = await render({ ...workspace, resources: fixed.repository! }, request);
      expect(historical).toEqual(baseline);
    }
    const versions = join(root, 'v1.json'); await json(versions, fixed.versions);
    const out = join(root, 'pinned');
    expect(await runCli(['render', '--workspace', workspaceDir, '--resources', dir, '--request', requestFile, '--versions', versions, '--out', out], io)).toBe(0);
    expect(new Uint8Array(await fs.readFile(join(out, 'image.png')))).toEqual(baseline.image!.bytes);
    expect(errors).toEqual([]);
  });

  it('CLI 拒绝无效参数、过期报告及覆盖报告，失败不改变版本', async () => {
    const io = { stdout: () => {}, stderr: () => {} };
    const report = join(root, 'check.json');
    const args = ['resources-check', '--resources', dir, '--workspace', workspaceDir, '--id', 'photo', '--kind', 'image', '--file', file, '--out', report];
    expect(await runCli(args, io)).toBe(0);
    expect(await runCli([...args, '--options', ''], io)).toBe(2);
    expect(await runCli(args, io)).toBe(1);
    expect(await runCli([...args.slice(0, -1), join(workspaceDir, 'report.json')], io)).toBe(2);
    expect(await runCli(['resources-get', '--resources', dir, '--id', 'photo', '--version', '1.5'], io)).toBe(2);
    expect(await runCli(['resources-get', '--resources', dir, '--id', 'photo', '--version', '99'], io)).toBe(1);
    await fs.writeFile(file, 'new again');
    expect(await runCli(['resources-apply', '--resources', dir, '--workspace', workspaceDir, '--file', file, '--check', report], io)).toBe(1);
    expect((await store()).get('photo')?.version).toBe(1);
  });
});
