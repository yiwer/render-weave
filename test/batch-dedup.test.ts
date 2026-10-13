import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { deliverBatch, importResources, initializeResourceStore, openVersionedResourceStore, readOutputRecord, replayOutputRecord,
  type VersionedResourceStore, type Workspace } from '../src/index.js';
import { greetingRequest, loadSingleText, resourcesDir } from './support/fixtures.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, open: vi.fn(actual.open), link: vi.fn(actual.link) };
});

let root: string, store: VersionedResourceStore, greeting: Workspace;
let sequence = 0;
const target = () => join(root, `batch-${++sequence}`);
const batch = (ids: string[]) => {
  const { template, mode, ...item } = greetingRequest();
  return { template, mode, items: ids.map((id) => ({ id, ...item })) };
};
/** 问候牌按缺省配置固定思源黑体四种字重作为后备字体，每条记录有 4 个字体副本。 */
const resourceFiles = async (dir: string) => (await fs.readdir(dir)).filter((file) => file.endsWith('.bin')).sort();
const identity = async (path: string) => { const stat = await fs.stat(path, { bigint: true }); return { ino: stat.ino, nlink: Number(stat.nlink) }; };
async function newStore(name: string): Promise<{ dir: string; store: VersionedResourceStore }> {
  const dir = join(root, name);
  expect((await initializeResourceStore(dir)).problems).toEqual([]);
  expect((await importResources({ sourceDir: resourcesDir, dir })).problems).toEqual([]);
  return { dir, store: (await openVersionedResourceStore(dir)).store! };
}

beforeAll(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'renderweave-dedup-'));
  ({ store } = await newStore('resources'));
  greeting = await loadSingleText();
});
afterEach(() => { vi.resetAllMocks(); vi.restoreAllMocks(); });
afterAll(async () => {
  if (!resolve(root).startsWith(join(resolve(tmpdir()), 'renderweave-dedup-'))) throw new Error('测试清理路径越界');
  await fs.rm(root, { recursive: true, force: true });
});

it('同批资源副本以硬链接共享：每项有自己的文件入口，只占一份磁盘', async () => {
  const out = target();
  const result = await deliverBatch({ workspace: greeting, resources: store, request: batch(['a', 'b', 'c']), outDir: out });
  expect(result.summary).toMatchObject({ total: 3, delivered: 3 });
  const files = await resourceFiles(join(out, '0001'));
  expect(files).toHaveLength(4);
  for (const file of files) {
    const first = await identity(join(out, '0001', file));
    expect(first.nlink).toBe(3);
    for (const item of ['0002', '0003']) expect((await identity(join(out, item, file))).ino).toBe(first.ino);
  }
  for (const item of result.items) expect((await readOutputRecord({ dir: item.directory! })).problems).toEqual([]);
});

it('删除同批其他项与原资源仓库后仍可读取和重放；单条复制到别处后重放一致', async () => {
  const own = await newStore('own-resources'), out = target();
  expect((await deliverBatch({ workspace: greeting, resources: own.store, request: batch(['a', 'b', 'c']), outDir: out })).summary.delivered).toBe(3);
  await fs.rm(join(out, '0001'), { recursive: true });
  await fs.rm(join(out, '0003'), { recursive: true });
  await fs.rm(own.dir, { recursive: true });
  const kept = join(out, '0002');
  for (const file of await resourceFiles(kept)) expect((await identity(join(kept, file))).nlink).toBe(1);
  expect((await readOutputRecord({ dir: kept })).record?.itemId).toBe('b');
  expect((await replayOutputRecord({ dir: kept, outDir: target() })).replayed).toBeDefined();
  const copy = target();
  await fs.cp(kept, copy, { recursive: true });
  expect((await replayOutputRecord({ dir: copy, outDir: target() })).replayed).toBeDefined();
});

it('硬链接失败时回退独立复制，交付照常成功，记录彼此独立', async () => {
  const original = (await vi.importActual<typeof fs>('node:fs/promises')).link;
  vi.mocked(fs.link).mockImplementation(async (from, to) => {
    if (String(to).endsWith('.bin')) throw Object.assign(new Error('injected EMLINK'), { code: 'EMLINK' });
    return original(from, to);
  });
  const out = target();
  const result = await deliverBatch({ workspace: greeting, resources: store, request: batch(['a', 'b']), outDir: out });
  expect(result.summary).toMatchObject({ total: 2, delivered: 2 });
  for (const file of await resourceFiles(join(out, '0001'))) {
    const [first, second] = [await identity(join(out, '0001', file)), await identity(join(out, '0002', file))];
    expect([first.nlink, second.nlink]).toEqual([1, 1]);
    expect(second.ino).not.toBe(first.ino);
  }
  for (const item of result.items) expect((await readOutputRecord({ dir: item.directory! })).problems).toEqual([]);
});

it('首项写资源失败时不作链接源：后续项自行写入，再供之后的项共享', async () => {
  const out = target();
  const original = (await vi.importActual<typeof fs>('node:fs/promises')).open;
  vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]) === join(out, '0001', 'font-000001.bin')) throw new Error('injected disk error');
    return original(...args);
  });
  const result = await deliverBatch({ workspace: greeting, resources: store, request: batch(['a', 'b', 'c']), outDir: out });
  expect(result.items.map((item) => item.status)).toEqual(['failed', 'delivered', 'delivered']);
  const [second, third] = [await identity(join(out, '0002', 'font-000001.bin')), await identity(join(out, '0003', 'font-000001.bin'))];
  expect(third.ino).toBe(second.ino); expect(second.nlink).toBe(2);
});

it('共享内容被原地改写时，同批每条记录都按自己的哈希拒绝', async () => {
  const out = target();
  expect((await deliverBatch({ workspace: greeting, resources: store, request: batch(['a', 'b']), outDir: out })).summary.delivered).toBe(2);
  const [file] = await resourceFiles(join(out, '0001'));
  await fs.writeFile(join(out, '0001', file!), 'damaged in place');
  for (const item of ['0001', '0002']) expect((await readOutputRecord({ dir: join(out, item) })).problems[0]?.code).toBe('record.integrityMismatch');
});
