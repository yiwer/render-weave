/**
 * 出图记录的查询、下载、导出与重放（票据 08，ADR-0019）：只经 HTTP 与命令行驱动。
 * - 导出包解开后与引擎在本地 deliver 的成果逐字节相同，并用命令行的 batch-read、record-read 与 replay 离线核对；
 * - 重放按记录里的构建标识交给那个构建的 worker；没有那个构建的 worker 时拒绝，写明缺哪个构建。
 *
 * 两种后端都在测试进程里起一个 worker（测试进程的构建）。PostgreSQL 加 S3 另有 Compose 里真实的 worker（镜像里的构建）：
 * 经真实的接口进程提交的批次由它交付，它的记录只能由它重放；两个构建各自重放成功，就证明重放是按构建路由的。
 * 对象被改坏时的完整性问题也只在这里测（直接改对象存储里的对象）。
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import yauzl from 'yauzl';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli.js';
import type { ServiceBackend } from '../src/backend.js';
import { deliverBatch, readWorkspaceDocuments, rendererBuildId } from '../src/engine.js';
import { inProcessRunner, startScheduler, type Scheduler } from '../src/worker/scheduler.js';
import { createWorld, type World } from './api-suite.js';
import { seedGreeting, seedStress, stressRequest } from './seed.js';

export interface RecordSuiteOptions {
  /** Compose 里真实的接口进程与 worker，以及改写对象存储里对象的办法。 */
  readonly realWorker?: {
    readonly apiUrl: string;
    readonly overwriteObject: (tenantId: string, sha256: string, bytes: Uint8Array) => Promise<void>;
  };
}

const OUTPUT = { width: 160, height: 40, dpi: 120, format: 'png' };
const inline = (message: string) => ({ inline: { dataset: { staticSchema: { name: '问候', version: 1 } }, data: { message } } });
/** 问候牌的三项：两项交付，一项的数据集不存在（失败项没有记录，只有问题清单）。 */
const greetingBatch = (tag: string) => ({ template: '问候牌', items: [
  { id: `${tag}-saved`, dataset: { id: 'ds-greeting' }, output: OUTPUT },
  { id: `${tag}-inline`, dataset: inline(`下一站 ${tag}`), output: OUTPUT },
  { id: `${tag}-missing`, dataset: { id: 'no-such-dataset' }, output: OUTPUT },
] });
const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, child() { return silentLogger; } } as never;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 解开 zip：条目名 → 字节。 */
export function unzip(bytes: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error);
      const entries = new Map<string, Buffer>();
      zip.on('entry', (entry: yauzl.Entry) => {
        if (entry.fileName.endsWith('/')) return zip.readEntry();
        zip.openReadStream(entry, (failure, stream) => {
          if (failure || !stream) return reject(failure);
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk)).on('end', () => { entries.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry(); }).on('error', reject);
        });
      });
      zip.on('end', () => resolve(entries)).on('error', reject);
      zip.readEntry();
    });
  });
}

/** 目录下全部文件：相对路径（用 /）→ 字节。 */
async function tree(dir: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files.set(relative(dir, path).split('\\').join('/'), await readFile(path));
  }
  return files;
}

export function describeRecords(name: string, makeBackend: () => Promise<ServiceBackend>, options: RecordSuiteOptions = {}): void {
  describe(`出图记录的查询、下载、导出与重放（${name}）`, () => {
    let world: World, backend: ServiceBackend, build: string, scheduler: Scheduler | undefined, root: string;
    /** 用例共用的两个批次：问候牌 3 项（2 项交付），压力细牌 1 项。 */
    let greeting: any, stress: any;
    beforeAll(async () => {
      backend = await makeBackend();
      build = await rendererBuildId();
      root = await mkdtemp(join(tmpdir(), 'renderweave-records-'));
      world = await createWorld(backend, { api: { limits: { maxElements: 100_000, maxLoopItems: 50_000 } } });
      await seedGreeting(backend.tenant(world.b.id).storage, { withFont: true });
      await seedStress(backend.tenant(world.b.id).storage);
      scheduler = startScheduler({ backend, runner: inProcessRunner(backend), logger: silentLogger, pollMs: 5, workerId: `records-${Math.random()}`, build, leaseMs: 60_000 });
      greeting = await finished(await submit(greetingBatch('甲')));
      const { template: _template, ...item } = stressRequest(3, { template: '压力细牌', height: 20 });
      stress = await finished(await submit({ template: '压力细牌', items: [{ id: 'stress-1', ...item }] }));
    });
    afterAll(async () => {
      await scheduler?.stop();
      await rm(root, { recursive: true, force: true });
    });

    const token = () => world.b.key.token;
    const submit = async (body: unknown) => {
      const reply = await world.call('POST', '/v1/batches', token(), body);
      expect(reply.status, reply.raw.slice(0, 300)).toBe(202);
      return reply.body.id as string;
    };
    const finished = async (id: string, timeoutMs = 60_000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const reply = await world.call('GET', `/v1/batches/${id}`, token());
        expect(reply.status).toBe(200);
        if (reply.body.status === 'finished') return reply.body;
        if (Date.now() > deadline) throw new Error(`批次 ${id} 没有在 ${timeoutMs} ms 内结束`);
        await sleep(20);
      }
    };
    const records = (query = '') => world.call('GET', `/v1/records${query}`, token());
    const extract = async (zip: Buffer, name: string) => {
      const dir = join(root, name);
      for (const [entry, bytes] of await unzip(zip)) {
        await mkdir(dirname(join(dir, entry)), { recursive: true });
        await writeFile(join(dir, entry), bytes);
      }
      return dir;
    };
    const cli = async (args: readonly string[]) => {
      const out: string[] = [];
      const code = await runCli(args, { stdout: (text) => out.push(text), stderr: (text) => out.push(text) });
      return { code, output: out.join('') };
    };
    const replay = (batchId: string, index: number) => world.call('POST', `/v1/batches/${batchId}/items/${index}/replay`, token());

    it('按时间、模板与批次查询出图记录：只有交付成功的项，按交付时间倒序，可以分页', async () => {
      const all = await records();
      expect(all.status, all.raw.slice(0, 300)).toBe(200);
      expect(all.body.records.map((record: any) => `${record.batchId} ${record.index} ${record.id}`).sort()).toEqual([
        `${greeting.id} 1 甲-saved`, `${greeting.id} 2 甲-inline`, `${stress.id} 1 stress-1`,
      ].sort());
      expect(all.body.records[0]).toEqual({ batchId: stress.id, index: 1, id: 'stress-1', template: '压力细牌', build, deliveredAt: expect.any(String), image: 'image.png' });
      const times = all.body.records.map((record: any) => record.deliveredAt);
      expect([...times].sort().reverse()).toEqual(times);

      expect((await records(`?batchId=${greeting.id}`)).body.records.map((record: any) => record.index).sort()).toEqual([1, 2]);
      expect((await records(`?template=${encodeURIComponent('压力细牌')}`)).body.records.map((record: any) => record.id)).toEqual(['stress-1']);
      expect((await records(`?template=${encodeURIComponent('没有这个模板')}`)).body.records).toEqual([]);
      const newest = times[0], oldest = times.at(-1);
      expect((await records(`?from=${encodeURIComponent(newest)}`)).body.records.every((record: any) => record.deliveredAt >= newest)).toBe(true);
      expect((await records(`?from=${encodeURIComponent(newest)}`)).body.records.length).toBeGreaterThan(0);
      expect((await records(`?to=${encodeURIComponent(oldest)}`)).body.records).toEqual([]);
      expect((await records(`?from=${encodeURIComponent(oldest)}&batchId=${greeting.id}`)).body.records).toHaveLength(2);

      const paged: unknown[] = [];
      let next: string | undefined;
      do {
        const page = await records(`?limit=1${next ? `&before=${next}` : ''}`);
        expect(page.status).toBe(200);
        expect(page.body.records.length).toBeLessThanOrEqual(1);
        paged.push(...page.body.records);
        next = page.body.next;
      } while (next);
      expect(paged).toEqual(all.body.records);

      for (const query of ['?limit=0', '?limit=501', '?from=yesterday', '?batchId=abc', '?before=%%%', '?extra=1']) {
        expect((await records(query)).status, query).toBe(400);
      }
    });

    it('下载单个文件与整批图片的压缩包：与交付时登记的字节相同；失败项只有问题清单', async () => {
      const { call } = world;
      const stored = backend.tenant(world.b.id).storage.openBatch(greeting.id);
      const image = await call('GET', `/v1/batches/${greeting.id}/items/1/files/image.png`, token());
      expect(image.status).toBe(200);
      expect(image.headers).toMatchObject({ 'content-type': 'image/png', 'x-content-type-options': 'nosniff' });
      expect(image.bytes.equals(Buffer.from(await stored.record(1).read('image.png')))).toBe(true);
      const record = await call('GET', `/v1/batches/${greeting.id}/items/2/files/record.json`, token());
      expect(record.headers['content-type']).toMatch(/^application\/json/);
      expect(record.bytes.equals(Buffer.from(await stored.record(2).read('record.json')))).toBe(true);
      expect((await call('GET', `/v1/batches/${greeting.id}/items/3/files/problems.json`, token())).body[0].code).toBe('input.datasetNotFound');
      for (const path of ['items/3/files/image.png', 'items/1/files/no-such.json', 'items/4/files/problems.json', 'items/0/files/image.png', 'items/1/files/..%2Frecord.json']) {
        expect((await call('GET', `/v1/batches/${greeting.id}/${path}`, token())).status, path).toBe(404);
      }

      const zip = await call('GET', `/v1/batches/${greeting.id}/images.zip`, token());
      expect(zip.status).toBe(200);
      expect(zip.headers).toMatchObject({ 'content-type': 'application/zip' });
      expect(zip.headers['content-disposition']).toContain(`batch-${greeting.id}-images.zip`);
      const entries = await unzip(zip.bytes);
      expect([...entries.keys()].sort()).toEqual(['0001.png', '0002.png']);
      for (const index of [1, 2]) expect(entries.get(`000${index}.png`)!.equals(Buffer.from(await stored.record(index).read('image.png')))).toBe(true);
    });

    it('按批次与按项导出：目录结构、文件名与内容和本地 deliver 的成果相同；导出包能用 batch-read、record-read 与 replay 离线通过', async () => {
      const { call } = world;
      const storage = backend.tenant(world.b.id).storage;
      const local = join(root, 'local-deliver');
      const delivered = await deliverBatch({ workspace: await readWorkspaceDocuments(storage.documents), resources: (await storage.resources.open()).store!,
        request: { ...greetingBatch('甲'), mode: 'final' }, outDir: local });
      expect(delivered.summary).toMatchObject({ delivered: 2, failed: 1 });

      const exported = await call('GET', `/v1/batches/${greeting.id}/export.zip`, token());
      expect(exported.status).toBe(200);
      expect(exported.headers['content-disposition']).toContain(`batch-${greeting.id}.zip`);
      const dir = await extract(exported.bytes, 'export');
      const top = `batch-${greeting.id}`;
      expect(await readdir(dir)).toEqual([top]);
      const service = await tree(join(dir, top)), expected = await tree(local);
      expect([...service.keys()].sort()).toEqual([...expected.keys()].sort());
      for (const [file, bytes] of expected) expect(service.get(file)!.equals(bytes), file).toBe(true);

      expect(await cli(['batch-read', '--batch', join(dir, top)])).toMatchObject({ code: 0 });
      for (const index of ['0001', '0002']) {
        expect(await cli(['record-read', '--record', join(dir, top, index)])).toMatchObject({ code: 0 });
        expect(await cli(['replay', '--record', join(dir, top, index), '--out', join(root, `replayed-${index}`)])).toMatchObject({ code: 0 });
      }

      const item = await call('GET', `/v1/batches/${greeting.id}/items/2/export.zip`, token());
      expect(item.status).toBe(200);
      const itemDir = await extract(item.bytes, 'export-item');
      const folder = `batch-${greeting.id}-0002`;
      expect(await readdir(itemDir)).toEqual([folder]);
      const itemFiles = await tree(join(itemDir, folder));
      expect([...itemFiles.keys()].sort()).toEqual([...expected.keys()].filter((file) => file.startsWith('0002/')).map((file) => file.slice(5)).sort());
      expect(await cli(['record-read', '--record', join(itemDir, folder)])).toMatchObject({ code: 0 });
      expect(await cli(['replay', '--record', join(itemDir, folder), '--out', join(root, 'replayed-item')])).toMatchObject({ code: 0 });
      // 失败项也能按项导出：只有问题清单，与本地的项目录相同。
      const failed = await extract((await call('GET', `/v1/batches/${greeting.id}/items/3/export.zip`, token())).bytes, 'export-failed');
      expect([...(await tree(join(failed, `batch-${greeting.id}-0003`))).keys()]).toEqual(['problems.json']);
      expect((await call('GET', `/v1/batches/${greeting.id}/items/9/export.zip`, token())).status).toBe(404);
    });

    it('重放交给记录所属构建的 worker：重新渲染与记录一致；没有那个构建的 worker 时拒绝，写明缺哪个构建', async () => {
      const replayed = await replay(greeting.id, 1);
      expect(replayed.status, replayed.raw.slice(0, 500)).toBe(200);
      expect(replayed.body).toMatchObject({ batchId: greeting.id, index: 1, id: '甲-saved', build, matched: true,
        replay: { format: 'renderweave-replay/1', build, itemId: '甲-saved', matched: true }, problems: expect.any(Array) });
      expect(replayed.body.replay.files.map((file: { file: string }) => file.file).sort()).toEqual(['image.png', 'layout.json', 'problems.json']);
      expect((await replay(greeting.id, 3)).status).toBe(404);
      expect((await replay(greeting.id, 9)).status).toBe(404);

      const start = world.clock.value;
      try {
        // 接口进程的时钟往后拨：worker 的心跳都过期了，看起来没有任何构建的 worker。
        world.clock.value = new Date(start.getTime() + 10 * 60_000);
        const missing = await replay(greeting.id, 2);
        expect(missing).toMatchObject({ status: 503, body: { problems: [{ code: 'replay.buildUnavailable' }] } });
        expect(missing.body.problems[0].message).toContain(build);
      } finally { world.clock.value = start; }
      expect((await replay(greeting.id, 2)).body.matched).toBe(true);
    });

    it('平台管理员看得到被记录引用的构建与在线的 worker：只要还有记录引用某个构建，就保留它的镜像', async () => {
      const builds = await world.call('GET', '/v1/platform/builds', world.platform);
      expect(builds.status).toBe(200);
      const entry = builds.body.builds.find((item: { build: string }) => item.build === build);
      expect(entry).toMatchObject({ build, records: expect.any(Number), lastDeliveredAt: expect.any(String), workers: expect.any(Number) });
      // 内存后端只有本组用例的记录：问候牌 2 项、压力细牌 1 项，失败项不算。PostgreSQL 里还有别的用例交付的同构建记录。
      if (options.realWorker) expect(entry.records).toBeGreaterThanOrEqual(3);
      else expect(entry.records).toBe(3);
      expect(entry.workers).toBeGreaterThanOrEqual(1);
      expect(entry.image).toBe(`renderweave-service:${build.replace(':', '-')}`);
      expect((await world.call('GET', '/v1/platform/builds', world.b.admin.token)).status).toBe(403);

      // 另一个构建的 worker 报到后在列，没有记录引用；停下时离开，不再算在线。
      const other = `sha256:${'0'.repeat(64)}`;
      const visiting = startScheduler({ backend, runner: inProcessRunner(backend), logger: silentLogger, pollMs: 50, workerId: `visiting-${Math.random()}`, build: other, leaseMs: 60_000 });
      const workersOf = async () => (await world.call('GET', '/v1/platform/builds', world.platform)).body.builds.find((item: { build: string }) => item.build === other);
      try {
        const deadline = Date.now() + 10_000;
        while (!(await workersOf()) && Date.now() < deadline) await sleep(20);
        expect(await workersOf()).toEqual({ build: other, image: `renderweave-service:sha256-${'0'.repeat(64)}`, records: 0, workers: 1 });
      } finally { await visiting.stop(); }
      expect(await workersOf()).toBeUndefined();
    });

    if (options.realWorker) {
      const real = options.realWorker;
      const viaRealApi = async (method: string, path: string, body?: unknown) => {
        const response = await fetch(`${real.apiUrl}${path}`, { method, headers: { authorization: `Bearer ${token()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}) });
        return { status: response.status, body: await response.json() as any };
      };

      it('两个构建：真实 worker（镜像里的构建）交付的记录由它重放，测试进程的 worker 交付的由测试进程的 worker 重放', async () => {
        const submitted = await viaRealApi('POST', '/v1/batches', greetingBatch('乙'));
        expect(submitted.status).toBe(202);
        const imageBuild = submitted.body.build as string;
        expect(imageBuild).not.toBe(build);
        const done = await finished(submitted.body.id);
        expect(done.summary).toMatchObject({ delivered: 2, failed: 1 });
        const viaImage = await replay(done.id, 1);
        expect(viaImage.status, JSON.stringify(viaImage.body)).toBe(200);
        expect(viaImage.body).toMatchObject({ build: imageBuild, matched: true, replay: { build: imageBuild } });
        const viaTester = await replay(greeting.id, 2);
        expect(viaTester.body).toMatchObject({ build, matched: true, replay: { build } });
        // 镜像里的构建交付的记录，测试进程的引擎（另一个构建）不能离线重放：重放只由确切构建完成。
        const dir = await extract((await world.call('GET', `/v1/batches/${done.id}/items/1/export.zip`, token())).bytes, 'export-image-build');
        const folder = join(dir, `batch-${done.id}-0001`);
        expect(await cli(['record-read', '--record', folder])).toMatchObject({ code: 0 });
        const offline = await cli(['replay', '--record', folder, '--out', join(root, 'replayed-image-build')]);
        expect(offline.code).toBe(1);
        expect(offline.output).toContain('record.buildMismatch');
        const listed = (await records(`?batchId=${done.id}`)).body.records;
        expect(listed.every((record: { build: string }) => record.build === imageBuild)).toBe(true);
      });

      it('读取时逐文件核对 SHA-256 与字节数：对象被改坏时下载、导出与重放都报完整性问题', async () => {
        const id = await submit({ template: '问候牌', items: [{ id: 'tampered', dataset: inline(`改坏 ${Date.now()}`), output: OUTPUT }] });
        await finished(id);
        const image = await world.call('GET', `/v1/batches/${id}/items/1/files/image.png`, token());
        const { createHash } = await import('node:crypto');
        await real.overwriteObject(world.b.id, createHash('sha256').update(image.bytes).digest('hex'), new Uint8Array(Buffer.from('不是图片')));
        const integrity = { status: 500, body: { problems: [{ code: 'record.integrityMismatch' }] } };
        for (const path of ['items/1/files/image.png', 'images.zip', 'export.zip', 'items/1/export.zip']) {
          expect(await world.call('GET', `/v1/batches/${id}/${path}`, token()), path).toMatchObject(integrity);
        }
        const replayed = await replay(id, 1);
        expect(replayed.body).toMatchObject({ matched: false, problems: [{ code: 'record.integrityMismatch' }] });
        // 没改坏的文件照常下载。
        expect((await world.call('GET', `/v1/batches/${id}/items/1/files/record.json`, token())).status).toBe(200);
      });
    }
  });
}
