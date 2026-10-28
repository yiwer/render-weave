/**
 * 出图记录的端点（票据 08，ADR-0019，M272、M273）：查询、下载、导出与重放。
 * - 查询：按登记时间倒序，可按批次、模板与时间筛选，按位置翻页；
 * - 下载与导出：每个文件都按登记的 SHA-256 与字节数核对，不符时答完整性问题；导出包的目录结构、文件名与内容和本地 deliver 的成果相同；
 * - 重放：按记录里的构建标识交给那个构建的 worker；没有那个构建的 worker 时直接拒绝，写明缺哪个构建。
 * 租户由身份决定；别的租户的批次与不存在的同样答 404。
 */
import { createReadStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RecordCursor, RegisteredFile, TenantScope } from '../backend.js';
import { itemDirectory, ProblemCodes } from '../engine.js';
import { IntegrityError, readRegistered } from '../records.js';
import { WORKER_STALE_MS } from '../worker/scheduler.js';
import { writeZip, type ZipEntry } from '../zip.js';
import { identityOf, ownTenant, type ApiContext } from './app.js';
import { ApiError, fail, notFound, objectId, ServiceProblemCodes } from './problems.js';

const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
/** ISO 8601 的时刻，带时区。 */
export const INSTANT = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d{1,9})?)?(Z|[+-]\\d{2}:\\d{2})$';
const INDEX = /^[1-9][0-9]{0,3}$/;
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const CONTENT_TYPES: Readonly<Record<string, string>> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json; charset=utf-8' };

/** 翻页位置写成 base64url 的 JSON，客户端原样带回。 */
const encodeCursor = (cursor: RecordCursor) => Buffer.from(JSON.stringify([cursor.at, cursor.batchId, cursor.index])).toString('base64url');
function decodeCursor(value: string): RecordCursor {
  const invalid = () => fail(400, ServiceProblemCodes.requestInvalid, 'request.querystring.before', 'before 要原样带回上一页的 next');
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { throw invalid(); }
  if (!Array.isArray(parsed) || parsed.length !== 3) throw invalid();
  const [at, batchId, index] = parsed as unknown[];
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at)) || typeof batchId !== 'string' || !new RegExp(UUID).test(batchId) || !Number.isInteger(index)) throw invalid();
  return { at, batchId, index: index as number };
}

/** 完整性问题：对象存储里的内容与登记的不符（500）。 */
const integrityProblem = (error: IntegrityError) =>
  new ApiError(500, [{ level: 'severe', code: ProblemCodes.recordIntegrityMismatch, location: { kind: 'input', source: error.file }, message: error.message }]);

export function registerRecordRoutes(app: FastifyInstance, context: ApiContext): void {
  const { backend, limits, now } = context;
  const scopeOf = (request: FastifyRequest) => backend.tenant(ownTenant(identityOf(request)));
  /** 路径里的批次；不在本租户时答 404。 */
  const batchOf = async (request: FastifyRequest) => {
    const scope = scopeOf(request), batchId = objectId((request.params as { batchId: string }).batchId);
    const state = await scope.tasks.batch(batchId);
    if (!state) throw notFound();
    return { scope, state, batch: scope.storage.openBatch(batchId) };
  };
  /** 路径里的项：已登记的才有文件；项序号不合规、没登记都答 404。 */
  const itemOf = async (request: FastifyRequest) => {
    const found = await batchOf(request), raw = (request.params as { index: string }).index;
    if (!INDEX.test(raw)) throw notFound();
    const index = Number(raw), files = await found.batch.itemFiles(index);
    if (!files) throw notFound();
    return { ...found, index, files };
  };
  const read = (scope: TenantScope, file: Pick<RegisteredFile, 'sha256'> & { byteLength?: number }, where: string) => readRegistered(scope.storage, file, where);
  /** 打包并回答；读到损坏的文件时答完整性问题，什么也不发。 */
  const sendZip = async (reply: FastifyReply, entries: ZipEntry[], mtime: Date, filename: string) => {
    let path: string;
    try { path = await writeZip(entries, mtime); }
    catch (error) {
      if (error instanceof IntegrityError) throw integrityProblem(error);
      throw error;
    }
    const stream = createReadStream(path);
    stream.on('close', () => void rm(path, { force: true }));
    return reply.type('application/zip').header('content-disposition', `attachment; filename="${filename}"`).send(stream);
  };
  const itemEntries = (scope: TenantScope, folder: string, location: string, files: readonly RegisteredFile[]): ZipEntry[] =>
    files.map((file) => ({ name: `${folder}/${file.name}`, read: () => read(scope, file, `${location}/${file.name}`) }));

  app.get('/v1/records', {
    config: { access: 'records.read' },
    schema: { querystring: { type: 'object', additionalProperties: false, properties: {
      batchId: { type: 'string', pattern: UUID }, template: { type: 'string', minLength: 1, maxLength: 500 },
      from: { type: 'string', pattern: INSTANT }, to: { type: 'string', pattern: INSTANT },
      limit: { type: 'string', pattern: '^([1-9][0-9]?|[1-4][0-9]{2}|500)$' }, before: { type: 'string', minLength: 1, maxLength: 1000 },
    } } },
  }, async (request) => {
    const query = request.query as { batchId?: string; template?: string; from?: string; to?: string; limit?: string; before?: string };
    const limit = Number(query.limit ?? 100);
    const records = await scopeOf(request).tasks.listRecords({
      ...(query.batchId ? { batchId: query.batchId } : {}), ...(query.template ? { template: query.template } : {}),
      ...(query.from ? { from: new Date(query.from) } : {}), ...(query.to ? { to: new Date(query.to) } : {}),
      ...(query.before ? { before: decodeCursor(query.before) } : {}), limit,
    });
    return {
      records: records.map(({ cursor: _cursor, ...record }) => record),
      ...(records.length === limit ? { next: encodeCursor(records.at(-1)!.cursor) } : {}),
    };
  });

  /** 一项的一个文件：图片按图片类型回答，JSON 按 JSON，其他按字节；一律不让浏览器猜类型。 */
  app.get('/v1/batches/:batchId/items/:index/files/:name', { config: { access: 'records.read' } }, async (request, reply) => {
    const { scope, state, index, files } = await itemOf(request);
    const name = (request.params as { name: string }).name;
    const file = FILE.test(name) ? files.find((candidate) => candidate.name === name) : undefined;
    if (!file) throw notFound();
    let bytes: Uint8Array;
    try { bytes = await read(scope, file, `batches/${state.batchId}/${itemDirectory(index)}/${name}`); }
    catch (error) {
      if (error instanceof IntegrityError) throw integrityProblem(error);
      throw error;
    }
    const type = CONTENT_TYPES[name.slice(name.lastIndexOf('.'))] ?? 'application/octet-stream';
    return reply.type(type).header('x-content-type-options', 'nosniff').send(Buffer.from(bytes));
  });

  /** 整批图片：交付成功的各项的图片，名字是项目录名加扩展名（如 0001.png）。 */
  app.get('/v1/batches/:batchId/images.zip', { config: { access: 'records.read' } }, async (request, reply) => {
    const { scope, state, batch } = await batchOf(request);
    const entries: ZipEntry[] = [];
    for (const item of state.items) {
      const files = await batch.itemFiles(item.index);
      if (!files?.some((file) => file.name === 'record.json')) continue;
      const image = files.find((file) => file.name === 'image.png' || file.name === 'image.jpg')!;
      const name = `${itemDirectory(item.index)}${image.name.slice(image.name.lastIndexOf('.'))}`;
      entries.push({ name, read: () => read(scope, image, `batches/${state.batchId}/${itemDirectory(item.index)}/${image.name}`) });
    }
    return sendZip(reply, entries, new Date(state.createdAt), `batch-${state.batchId}-images.zip`);
  });

  /** 按批次导出：与本地 deliver 的批次目录相同，批次清单发布了就带 batch.json，各项目录里是登记的全部文件。 */
  app.get('/v1/batches/:batchId/export.zip', { config: { access: 'records.read' } }, async (request, reply) => {
    const { scope, state, batch } = await batchOf(request);
    const top = `batch-${state.batchId}`, location = `batches/${state.batchId}`;
    const entries: ZipEntry[] = [];
    const manifest = await batch.manifestSha256();
    if (manifest) entries.push({ name: `${top}/batch.json`, read: () => read(scope, { sha256: manifest }, `${location}/batch.json`) });
    for (const item of state.items) {
      const files = await batch.itemFiles(item.index);
      if (files) entries.push(...itemEntries(scope, `${top}/${itemDirectory(item.index)}`, `${location}/${itemDirectory(item.index)}`, files));
    }
    return sendZip(reply, entries, new Date(state.createdAt), `${top}.zip`);
  });

  /** 按项导出：这一项的目录，能直接交给 record-read 与 replay。 */
  app.get('/v1/batches/:batchId/items/:index/export.zip', { config: { access: 'records.read' } }, async (request, reply) => {
    const { scope, state, index, files } = await itemOf(request);
    const folder = `batch-${state.batchId}-${itemDirectory(index)}`;
    return sendZip(reply, itemEntries(scope, folder, `batches/${state.batchId}/${itemDirectory(index)}`, files), new Date(state.createdAt), `${folder}.zip`);
  });

  /** 重放：交给记录所属构建的 worker，同步等结果；限并发与频率，与预览各算各的。 */
  app.post('/v1/batches/:batchId/items/:index/replay', { config: { access: 'records.read' } }, async (request) => {
    const { scope, state, index, files } = await itemOf(request);
    const recordFile = files.find((file) => file.name === 'record.json');
    if (!recordFile) throw notFound();
    let build: unknown;
    try { build = (JSON.parse(Buffer.from(await read(scope, recordFile, `batches/${state.batchId}/${itemDirectory(index)}/record.json`)).toString('utf8')) as { build?: unknown }).build; }
    catch (error) {
      if (error instanceof IntegrityError) throw integrityProblem(error);
      throw error;
    }
    if (typeof build !== 'string') throw new Error('出图记录没有构建标识');
    const online = await backend.workers.online(new Date(now().getTime() - WORKER_STALE_MS));
    if (!online.get(build)) {
      throw fail(503, ServiceProblemCodes.replayBuildUnavailable, 'request.path', `这条记录由构建 ${build} 产出，现在没有这个构建的 worker。`
        + `记录只由确切构建重放：用保留的镜像 renderweave-service:${build.replace(':', '-')} 起一个 worker 后再重放`);
    }
    const { concurrency } = await scope.plan();
    const queued = await scope.tasks.enqueueReplay({ batchId: state.batchId, index, build },
      { concurrency, perMinute: limits.previewPerMinute, staleAfterMs: limits.previewWaitMs }, now());
    if ('limited' in queued) {
      throw fail(429, ServiceProblemCodes.replayRateLimited, 'request', queued.limited === 'concurrency'
        ? `本租户同时进行的重放已达并发上限 ${concurrency} 个，请等前面的完成`
        : `本租户一分钟内的重放已达每分钟上限 ${limits.previewPerMinute} 次，请稍后再试`);
    }
    const deadline = Date.now() + limits.previewWaitMs;
    for (;;) {
      const replayed = await scope.tasks.replayState(queued.id);
      if (replayed?.status === 'done') {
        await scope.tasks.release(queued.id);
        const { manifest, problems } = replayed.result;
        const item = state.items.find((candidate) => candidate.index === index)!;
        return { batchId: state.batchId, index, id: item.id, build, matched: Boolean(manifest), ...(manifest ? { replay: manifest } : {}), problems };
      }
      if (Date.now() > deadline) {
        await scope.tasks.release(queued.id);
        throw fail(503, ServiceProblemCodes.workerUnavailable, 'request', `等了 ${limits.previewWaitMs} ms 还没有构建 ${build} 的 worker 重放完，请稍后再试`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  });

  /** 平台管理员：被记录引用的构建与在线的 worker。只要还有记录引用某个构建，就保留它的镜像（ADR-0019）。 */
  app.get('/v1/platform/builds', { config: { access: 'platform.tenants' } }, async () => {
    const [records, online] = await Promise.all([backend.platform.recordBuilds(), backend.workers.online(new Date(now().getTime() - WORKER_STALE_MS))]);
    const referenced = new Map(records.map((entry) => [entry.build, entry]));
    const builds = [...new Set([...referenced.keys(), ...online.keys()])].sort();
    return { builds: builds.map((build) => {
      const entry = referenced.get(build);
      return { build, image: `renderweave-service:${build.replace(':', '-')}`, records: entry?.records ?? 0,
        ...(entry ? { lastDeliveredAt: entry.lastDeliveredAt } : {}), workers: online.get(build) ?? 0 };
    }) };
  });
}

