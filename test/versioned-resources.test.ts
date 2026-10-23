import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkResourceReplacement, importResources, initializeResourceStore, loadWorkspace, openResourceRepository,
  openVersionedResourceStore, ProblemCodes, render, ResourceReadError } from '../src/index.js';
import { runCli } from '../src/cli.js';
import { m402Dir, resourcesDir } from './support/fixtures.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

let root: string, target: string, source: string;
const bytes = Uint8Array.from([0, 1, 127, 128, 255]);
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const manifest = (dir: string) => join(dir, 'resources.json');
async function writeSource(entries: unknown = [{ id: 'photo', kind: 'image', file: 'content.bin' }]) {
  await fs.writeFile(manifest(source), JSON.stringify({ resources: entries }));
}
async function store() {
  const result = await openVersionedResourceStore(target);
  expect(result.problems).toEqual([]);
  return result.store!;
}
async function importSource() { return importResources({ sourceDir: source, dir: target }); }
async function diskManifest() { return JSON.parse(await fs.readFile(manifest(target), 'utf8')); }
async function contentFile(id = 'photo') {
  return join(target, (await diskManifest()).resources.find((item: { id: string }) => item.id === id).versions[0].file);
}
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'renderweave-resources-'));
  target = join(root, 'target'); source = join(root, 'source');
  await fs.mkdir(source);
  await fs.writeFile(join(source, 'content.bin'), bytes);
  await writeSource();
  expect((await initializeResourceStore(target)).problems).toEqual([]);
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (!resolve(root).startsWith(join(resolve(tmpdir()), 'renderweave-resources-'))) throw new Error('测试清理路径越界');
  await fs.rm(root, { recursive: true, force: true });
});

describe('资源版本公开边界', () => {
  it('保留 ID、种类、字节；查询与明确版本读取；源文件变化不改变 v1', async () => {
    await writeSource([{ id: 'photo', kind: 'image', file: 'content.bin' }, { id: 'font', kind: 'font', file: 'content.bin' }]);
    const original = await fs.readFile(manifest(source));
    const result = await importSource();
    expect(result.problems).toEqual([]);
    expect(result.imported).toHaveLength(2);
    const opened = await store();
    expect(opened.get('photo')).toEqual({ id: 'photo', kind: 'image', version: 1, byteLength: bytes.length, sha256: digest(bytes) });
    expect(opened.get('font', 1)?.kind).toBe('font');
    expect(await opened.read('photo', 1)).toEqual(bytes);
    expect(await fs.readFile(manifest(source))).toEqual(original);
    expect(new Uint8Array(await fs.readFile(join(source, 'content.bin')))).toEqual(bytes);
    await fs.writeFile(join(source, 'content.bin'), 'new bytes');
    expect(await opened.read('photo', 1)).toEqual(bytes);
    expect(await (await openResourceRepository(source)).repository.read('photo')).toEqual(new Uint8Array(Buffer.from('new bytes')));
    await expect(opened.read('photo', 2)).rejects.toMatchObject({ resourceId: 'photo', code: ProblemCodes.resourceVersionNotFound });
  });

  it('映射复制、元信息隔离、原型名称及大小写 ID 均正确，不补入未固定的资源', async () => {
    await writeSource(['Photo', 'photo', 'constructor', 'toString'].map((id) => ({ id, kind: 'image', file: 'content.bin' })));
    expect((await importSource()).problems).toEqual([]);
    const opened = await store();
    const selected = { constructor: 1 };
    const pinned = opened.pin(selected);
    selected.constructor = 2;
    expect(pinned.versions).toEqual({ constructor: 1 });
    expect(Object.isFrozen(pinned.versions)).toBe(true);
    expect(await pinned.repository!.read('constructor')).toEqual(bytes);
    expect(pinned.repository!.get('toString')).toBeUndefined();
    await expect(pinned.repository!.read('toString')).rejects.toBeInstanceOf(ResourceReadError);
    (opened.get('photo') as { version: number }).version = 9;
    expect(opened.get('photo')?.version).toBe(1);
    expect(opened.list()).toHaveLength(4);
    expect(opened.pin({ missing: 1 }).repository).toBeUndefined();
    expect(opened.pin({ photo: 2 }).problems[0]?.location).toEqual({ kind: 'input', source: 'resourceVersions.photo' });
    expect(opened.pin({ photo: 0 }).repository).toBeUndefined();
  });

  it('已打开快照固定原清单，后续导入仅在重开后出现', async () => {
    const opened = await store();
    expect((await importSource()).problems).toEqual([]);
    expect(opened.list()).toEqual([]);
    expect(opened.pin().repository!.get('photo')).toBeUndefined();
    expect((await store()).get('photo')?.version).toBe(1);
  });

  it('重复导入和初始化不覆盖现有内容；冲突使整批不可见', async () => {
    await importSource();
    const before = await fs.readFile(manifest(target));
    await writeSource([{ id: 'new', kind: 'image', file: 'content.bin' }, { id: 'photo', kind: 'font', file: 'content.bin' }]);
    expect((await importSource()).problems[0]?.code).toBe(ProblemCodes.inputDuplicate);
    expect((await initializeResourceStore(target)).problems[0]?.level).toBe('severe');
    expect(await fs.readFile(manifest(target))).toEqual(before);
    expect((await store()).get('new')).toBeUndefined();
    expect(await (await store()).read('photo', 1)).toEqual(bytes);
    const legacyBefore = await fs.readFile(manifest(source));
    expect((await initializeResourceStore(source)).problems[0]?.level).toBe('severe');
    expect(await fs.readFile(manifest(source))).toEqual(legacyBefore);
  });

  it('同源重复 ID 整批拒绝，问题定位到 ID', async () => {
    await writeSource(Array.from({ length: 2 }, () => ({ id: 'photo', kind: 'image', file: 'content.bin' })));
    const result = await importSource();
    expect(result.imported).toEqual([]);
    expect(result.problems[0]).toMatchObject({ code: ProblemCodes.inputDuplicate, location: { source: expect.stringContaining('#photo') } });
    expect((await store()).list()).toEqual([]);
  });

  it.each(['../content.bin', '..\\content.bin', '/outside', 'C:\\outside', 'C:outside', 'content.bin:stream', './content.bin', 'missing.bin', ''])('拒绝非法或不可读源路径：%s', async (file) => {
    await writeSource([{ id: 'photo', kind: 'image', file }]);
    const result = await importSource();
    expect(result.imported).toEqual([]);
    expect(result.problems[0]).toMatchObject({ level: 'severe', location: { source: expect.stringContaining('#photo') } });
    expect((await store()).list()).toEqual([]);
  });

  it('拒绝源 junction 和目标内容目录 junction，不向链接目的地写入', async () => {
    const outside = join(root, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(join(outside, 'content.bin'), bytes);
    await fs.symlink(outside, join(source, 'linked'), 'junction');
    await writeSource([{ id: 'photo', kind: 'image', file: 'linked/content.bin' }]);
    expect((await importSource()).problems[0]?.level).toBe('severe');
    await fs.rmdir(join(target, 'objects'));
    await fs.symlink(outside, join(target, 'objects'), 'junction');
    await writeSource();
    expect((await importSource()).problems[0]?.level).toBe('severe');
    expect(await fs.readdir(outside)).toEqual(['content.bin']);
  });

  it('第二份源不可读时撤回已写入内容，已有资源仍可用', async () => {
    await importSource();
    const before = await fs.readFile(manifest(target));
    const files = await fs.readdir(join(target, 'objects'));
    await writeSource([{ id: 'new', kind: 'image', file: 'content.bin' }, { id: 'broken', kind: 'font', file: 'absent' }]);
    expect((await importSource()).problems[0]?.code).toBe(ProblemCodes.resourceUnreadable);
    expect(await fs.readFile(manifest(target))).toEqual(before);
    expect(await fs.readdir(join(target, 'objects'))).toEqual(files);
    expect(await (await store()).read('photo', 1)).toEqual(bytes);
  });

  it('清单发布 I/O 失败时旧仓库完整可用，撤回内容且释放写锁供重试', async () => {
    await importSource();
    await writeSource([{ id: 'second', kind: 'font', file: 'content.bin' }]);
    const before = await fs.readFile(manifest(target));
    const files = await fs.readdir(join(target, 'objects'));
    vi.mocked(fs.rename).mockRejectedValueOnce(Object.assign(new Error('disk I/O error'), { code: 'EIO' }));
    const failed = await importSource();
    expect(failed.imported).toEqual([]);
    expect(failed.problems[0]?.code).toBe(ProblemCodes.resourceWriteFailed);
    expect(await fs.readFile(manifest(target))).toEqual(before);
    expect(await fs.readdir(join(target, 'objects'))).toEqual(files);
    expect(await (await store()).read('photo', 1)).toEqual(bytes);
    expect((await importSource()).problems).toEqual([]);
  });

  it('同一目标并发导入仅有一次提交，失败者不删除胜者文件', async () => {
    const results = await Promise.all([importSource(), importSource()]);
    expect(results.filter((result) => result.problems.length === 0)).toHaveLength(1);
    for (const issue of results.flatMap((result) => result.problems)) expect([ProblemCodes.resourceStoreBusy, ProblemCodes.inputDuplicate]).toContain(issue.code);
    expect((await store()).list()).toHaveLength(1);
    expect(await (await store()).read('photo', 1)).toEqual(bytes);
    expect(await fs.readdir(join(target, 'objects'))).toHaveLength(1);
  });

  it('内容写完而清单尚未提交时读者只见旧清单，其他写者得到 busy', async () => {
    expect((await importSource()).problems).toEqual([]);
    await writeSource([{ id: 'second', kind: 'font', file: 'content.bin' }]);
    const actual = await vi.importActual<typeof fs>('node:fs/promises');
    let notifyReached!: () => void, allowCommit!: () => void;
    const reached = new Promise<void>((resolve) => { notifyReached = resolve; });
    const release = new Promise<void>((resolve) => { allowCommit = resolve; });
    vi.mocked(fs.rename).mockImplementationOnce(async (from, to) => {
      notifyReached();
      await release;
      await actual.rename(from, to);
    });
    const pending = importSource();
    await reached;
    try {
      const during = await store();
      expect(during.list().map((item) => item.id)).toEqual(['photo']);
      expect(await during.read('photo', 1)).toEqual(bytes);
      expect((await importSource()).problems[0]?.code).toBe(ProblemCodes.resourceStoreBusy);
    } finally { allowCommit(); await pending; }
    expect((await pending).problems).toEqual([]);
    expect((await store()).list().map((item) => item.id)).toEqual(['photo', 'second']);
  });

  it.each(['{', 'null', '{}', '{"resources":[{"id":"x","kind":"other","file":"content.bin"}]}', '{"resources":[{"id":"../x","kind":"image","file":"content.bin"}]}'])('源清单结构错误定位到源文件：%s', async (value) => {
    await fs.writeFile(manifest(source), value);
    const result = await importSource();
    expect(result.problems[0]).toMatchObject({ code: ProblemCodes.inputUnreadable, location: { source: expect.stringContaining(await fs.realpath(manifest(source))) } });
    expect((await store()).list()).toEqual([]);
  });

  it('并发初始化不覆盖另一调用已发布的清单', async () => {
    const dir = join(root, 'empty');
    const results = await Promise.all([initializeResourceStore(dir), initializeResourceStore(dir)]);
    expect(results.filter((result) => !result.problems.length)).toHaveLength(1);
    expect((await openVersionedResourceStore(dir)).store?.list()).toEqual([]);
  });

  it.each(['same-size', 'different-size', 'missing'])('损坏内容不可作为 v1 读取：%s', async (damage) => {
    expect((await importSource()).problems).toEqual([]);
    const opened = await store();
    const file = await contentFile();
    if (damage === 'missing') await fs.unlink(file);
    else await fs.writeFile(file, damage === 'same-size' ? Uint8Array.from([9, 9, 9, 9, 9]) : 'changed');
    expect(opened.get('photo')?.sha256).toBe(digest(bytes));
    await expect(opened.read('photo', 1)).rejects.toMatchObject({ resourceId: 'photo', code: damage === 'missing' ? ProblemCodes.resourceUnreadable : ProblemCodes.resourceIntegrityMismatch });
  });

  it.runIf(process.platform === 'win32')('清单替换短暂 EPERM 后仍可提交，旧内容不丢失', async () => {
    for (let i = 0; i < 5; i++) vi.mocked(fs.rename).mockRejectedValueOnce(Object.assign(new Error('temporary rename denial'), { code: 'EPERM' }));
    const result = await importSource();
    expect(result.problems).toEqual([]);
    expect(await (await store()).read('photo', 1)).toEqual(bytes);
  });

  it.runIf(process.platform === 'win32')('清单替换持续 EPERM 时有限失败、保留旧清单并释放写锁', async () => {
    const before = await fs.readFile(manifest(target));
    const actual = await vi.importActual<typeof fs>('node:fs/promises');
    vi.mocked(fs.rename).mockRejectedValue(Object.assign(new Error('persistent rename denial'), { code: 'EPERM' }));
    try {
      expect((await importSource()).problems[0]?.code).toBe(ProblemCodes.resourceWriteFailed);
      expect(await fs.readFile(manifest(target))).toEqual(before);
      expect(await fs.readdir(join(target, 'objects'))).toEqual([]);
    } finally { vi.mocked(fs.rename).mockImplementation(actual.rename); }
    expect((await importSource()).problems).toEqual([]);
  });

  it.each(['hash', 'version', 'path', 'current', 'kind', 'duplicate', 'format'])('损坏版本清单整体拒绝：%s', async (damage) => {
    await importSource();
    const value = await diskManifest();
    const entry = value.resources[0];
    if (damage === 'hash') entry.versions[0].sha256 = 'invalid';
    if (damage === 'version') entry.versions[0].version = 2;
    if (damage === 'path') entry.versions[0].file = '../source/content.bin';
    if (damage === 'current') entry.currentVersion = 2;
    if (damage === 'kind') entry.kind = 'other';
    if (damage === 'duplicate') value.resources.push(entry);
    if (damage === 'format') value.format = 'renderweave-resources/999';
    await fs.writeFile(manifest(target), JSON.stringify(value));
    const opened = await openVersionedResourceStore(target);
    expect(opened.store).toBeUndefined();
    expect(opened.problems[0]?.location.kind).toBe('input');
    const compatible = await openResourceRepository(target);
    expect(compatible.repository.get('photo')).toBeUndefined();
    expect(compatible.problems).toEqual(opened.problems);
  });
});

describe('CLI 与实际出图', () => {
  it('临时工作区准备、导入、查询、M402 出图均成功；旧/自动打开/固定映射三个结果一致', async () => {
    const dir = join(root, 'cli-store');
    const workspaceDir = join(root, 'workspace');
    await fs.cp(m402Dir, workspaceDir, { recursive: true });
    const output: string[] = [], errors: string[] = [];
    const io = { stdout: (value: string) => output.push(value), stderr: (value: string) => errors.push(value) };
    expect(await runCli(['resources-init', '--resources', dir], io)).toBe(0);
    expect(await runCli(['resources-import', '--source', resourcesDir, '--resources', dir], io)).toBe(0);
    output.length = 0;
    expect(await runCli(['resources-list', '--resources', dir], io)).toBe(0);
    const listed = JSON.parse(output.join(''));
    const sourceManifest = JSON.parse(await fs.readFile(join(resourcesDir, 'resources.json'), 'utf8'));
    expect(listed).toHaveLength(sourceManifest.resources.length);
    expect(listed.every((item: { version: number }) => item.version === 1)).toBe(true);
    const requestFile = join(workspaceDir, 'render-request-m402.json');
    const out = join(root, 'output');
    expect(await runCli(['render', '--workspace', workspaceDir, '--resources', dir, '--request', requestFile, '--out', out], io)).toBe(0);
    expect(errors).toEqual([]);
    const request = JSON.parse(await fs.readFile(requestFile, 'utf8'));
    const old = await loadWorkspace({ dir: workspaceDir, resourcesDir });
    const baseline = await render(old, request);
    expect(baseline.problems).toEqual([]);
    expect(new Uint8Array(await fs.readFile(join(out, 'image.png')))).toEqual(baseline.image!.bytes);
    expect(JSON.parse(await fs.readFile(join(out, 'layout.json'), 'utf8'))).toEqual(baseline.layout);
    expect(JSON.parse(await fs.readFile(join(out, 'problems.json'), 'utf8'))).toEqual(baseline.problems);
    const opened = (await openVersionedResourceStore(dir)).store!;
    const pinned = opened.pin(Object.fromEntries(listed.map((item: { id: string; version: number }) => [item.id, item.version])));
    const fixed = await render({ ...old, resources: pinned.repository! }, request);
    expect(fixed).toEqual(baseline);
    // 破坏正在使用的图片资源；诊断须保留资源完整性代码并定位到模板元素。
    const value = JSON.parse(await fs.readFile(manifest(dir), 'utf8'));
    await fs.writeFile(join(dir, value.resources.find((item: { id: string }) => item.id === 'route-no-m402').versions[0].file), 'corrupt');
    const final = await render({ ...old, resources: pinned.repository! }, request);
    const draft = await render({ ...old, resources: pinned.repository! }, { ...request, mode: 'draft' });
    expect(final.image).toBeUndefined();
    expect(draft.image).toBeDefined();
    expect(final.problems).toEqual(draft.problems);
    expect(final.problems).toContainEqual(expect.objectContaining({ code: ProblemCodes.resourceIntegrityMismatch, location: expect.objectContaining({ kind: 'element' }) }));
    const imageFile = value.resources.find((item: { id: string }) => item.id === 'route-no-m402').versions[0].file;
    await fs.writeFile(join(dir, imageFile), await old.resources.read('route-no-m402'));
    const fontFile = value.resources.find((item: { id: string }) => item.id === 'font-hei-medium').versions[0].file;
    await fs.writeFile(join(dir, fontFile), 'corrupt font');
    const brokenFont = await render({ ...old, resources: pinned.repository! }, request);
    expect(brokenFont.image).toBeUndefined();
    expect(brokenFont.problems).toContainEqual(expect.objectContaining({ code: ProblemCodes.resourceIntegrityMismatch, message: expect.stringContaining('font-hei-medium v1'), location: expect.objectContaining({ kind: 'element' }) }));
  });

  it('参数与资源错误返回稳定退出码，不伪报成功', async () => {
    const errors: string[] = [];
    const io = { stdout: () => {}, stderr: (value: string) => errors.push(value) };
    expect(await runCli(['resources-import', '--resources', target], io)).toBe(2);
    expect(await runCli(['constructor'], io)).toBe(2);
    expect(await runCli(['resources-list', '--resources', source], io)).toBe(1);
    expect(await runCli(['resources-import', '--source', join(root, 'absent'), '--resources', target], io)).toBe(1);
    expect(errors.join('')).toContain('input.unreadable');
  });
});

describe('还不是版本仓库的目录提示先初始化（M239）', () => {
  const run = async (args: string[]) => {
    const errors: string[] = [];
    const code = await runCli(args, { stdout: () => {}, stderr: (value: string) => errors.push(value) });
    return { code, errors: errors.join('') };
  };

  it.each([['目录不存在', false], ['目录为空', true]])('%s时导入提示先 resources-init，不报 ENOENT，也不留下文件', async (_, create) => {
    const dir = join(root, 'uninitialized');
    if (create) await fs.mkdir(dir);
    const result = await run(['resources-import', '--source', source, '--resources', dir]);
    expect(result.code).toBe(1);
    expect(result.errors).toContain('input.unreadable');
    expect(result.errors).toContain(`resources-init --resources ${dir}`);
    expect(result.errors).not.toContain('ENOENT');
    expect(create ? await fs.readdir(dir) : await fs.stat(dir).then(() => 'exists', () => 'absent')).toEqual(create ? [] : 'absent');
  });

  it.each([['目录不存在', false], ['目录为空', true]])('%s时打开、列出、替换检查都给同一条提示', async (_, create) => {
    const dir = join(root, 'uninitialized');
    if (create) await fs.mkdir(dir);
    const opened = await openVersionedResourceStore(dir);
    expect(opened.problems).toEqual([expect.objectContaining({ code: ProblemCodes.inputUnreadable, message: expect.stringContaining(`resources-init --resources ${dir}`) })]);
    expect(opened.problems[0]!.message).not.toContain('ENOENT');
    expect((await run(['resources-list', '--resources', dir])).errors).toContain(opened.problems[0]!.message);
    const check = await checkResourceReplacement({ dir, workspaceDir: m402Dir, id: 'photo', kind: 'image', file: join(source, 'content.bin') });
    expect(check.problems.map((item) => item.message)).toEqual([opened.problems[0]!.message]);
  });

  it('旧版资源目录当作版本仓库时，提示新建仓库再从它导入', async () => {
    const opened = await openVersionedResourceStore(source);
    expect(opened.problems).toEqual([expect.objectContaining({ code: ProblemCodes.inputUnreadable,
      message: expect.stringMatching(/旧版资源目录.*resources-init.*resources-import --source /) })]);
    expect(opened.problems[0]!.message).toContain(`--source ${await fs.realpath(source)}`);
  });
});
