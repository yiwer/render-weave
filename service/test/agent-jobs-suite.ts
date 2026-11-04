import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { ServiceBackend } from '../src/backend.js';
import { advanceJob } from '../src/agent-jobs.js';
import { startAgentWorker } from '../src/agent-worker.js';
import { createWorld } from './api-suite.js';
import { seedDocuments } from './seed.js';
import { commentSchema, commentWorkbook, fixtureExtractor, note } from './agent-jobs-fixture.js';
export function describeAgentJobs(name: string, makeBackend: () => Promise<ServiceBackend>) {
describe(name, () => {
let backend: ServiceBackend;
let world: Awaited<ReturnType<typeof createWorld>>, worker: ReturnType<typeof startAgentWorker>, workbook: Buffer, root: string;
beforeAll(async () => {
  backend = await makeBackend();
  root = await mkdtemp(join(tmpdir(), 'rw-job-test-'));
  workbook = await commentWorkbook(root); world = await createWorld(backend, { api: { datasetAgentEnabled: true, limits: { maxWorkbookBytes: 8192 } } });
  const schema = commentSchema();
  await seedDocuments(backend.tenant(world.b.id).storage, [schema.definition, schema.compiled].map(d => Buffer.from(JSON.stringify(d))));
  worker = startAgentWorker({ backend, extract: fixtureExtractor, pollMs: 20 });
});
afterAll(async () => { await worker?.stop(); await world?.app.close(); if (root) await rm(root, { recursive: true, force: true }); });
const create = async (id = randomUUID()) => {
  const body = { requestId: id, staticSchema: commentSchema().ref, workbook: workbook.toString('base64'), filename: '批注.xlsx', brief: '生成两份物料卡，保留全部批注' };
  const reply = await world.call('POST', '/v1/agent-jobs', world.b.operator.token, body);
  expect(reply.status, reply.raw).toBe(202); return { id, body };
};
const ready = async (id: string) => {
  await expect.poll(async () => (await world.call('GET', `/v1/agent-jobs/${id}`, world.b.operator.token)).body.job?.status, { timeout: 15000 }).toBe('needsReview');
  return (await world.call('GET', `/v1/agent-jobs/${id}`, world.b.operator.token)).body;
};
it('上限由服务配置返回，超限原件不能入队', async () => {
  const limits = await world.call('GET', '/v1/agent-jobs', world.b.operator.token);
  expect(limits.body.maxWorkbookBytes).toBe(8192);
  const bytes = Buffer.alloc(8193); bytes[0] = 0x50; bytes[1] = 0x4b;
  const reply = await world.call('POST', '/v1/agent-jobs', world.b.operator.token, { staticSchema: commentSchema().ref, workbook: bytes.toString('base64'), filename: '超限.xlsx', brief: 'test' });
  expect(reply.status, reply.raw).toBe(413);
  expect((await world.call('GET', '/v1/agent-jobs', world.b.operator.token)).body.jobs).toHaveLength(0);
});
it('上传幂等、关闭页面后仍完成；固定原件与批注可查，人工改值有原因，应用整组且可幂等重试', async () => {
  const { id, body } = await create();
  expect((await world.call('POST', '/v1/agent-jobs', world.b.operator.token, body)).status).toBe(200);
  expect((await world.call('POST', '/v1/agent-jobs', world.b.operator.token, { ...body, brief: '另一要求' })).status).toBe(409);
  const detail = await ready(id), view = detail.review;
  expect(view.excel.comments[0]).toMatchObject({ cell: 'B2', text: note, vml: { row: 1, column: 1 } });
  const cells = await world.call('GET', `/v1/agent-jobs/${id}/cells?sheet=sheet-1&cell=A1`, world.b.operator.token);
  expect(cells.body.cells[0]).toMatchObject({ address: 'A1', value: '甲' });
  const candidate = view.candidates[0], item = view.pending.find((p: any) => p.file === candidate.path).item;
  const document = { ...candidate.document, data: { ...candidate.document.data, label: '甲（人工核准）' } };
  expect((await world.call('POST', `/v1/agent-jobs/${id}/review`, world.b.operator.token, { revision: detail.job.revision, item, document, reason: '' })).status).toBe(400);
  const edited = await world.call('POST', `/v1/agent-jobs/${id}/review`, world.b.operator.token, { revision: detail.job.revision, item, document, reason: '按原件核准名称' });
  expect(edited.status, edited.raw).toBe(200);
  expect((await world.call('POST', `/v1/agent-jobs/${id}/apply`, world.b.operator.token, { revision: detail.job.revision, confirmed: true })).status).toBe(409);
  const apply = () => world.call('POST', `/v1/agent-jobs/${id}/apply`, world.b.operator.token, { revision: edited.body.job.revision, confirmed: true });
  const applied = await apply(); expect(applied.status, applied.raw).toBe(200); expect(applied.body.job.datasetIds).toHaveLength(2);
  expect((await apply()).body.job.datasetIds).toEqual(applied.body.job.datasetIds);
  expect((await world.call('GET', `/v1/datasets/${id}-1`, world.b.operator.token)).body.data.label).toBe('甲（人工核准）');
  const events = (await world.call('GET', '/v1/audit-events?limit=500', world.b.admin.token)).body.events;
  expect(events.filter((e: any) => e.action === 'agent.apply' && e.object.id === id)).toHaveLength(1);
});
it('最后一份 ID 冲突时整组拒绝，前面的候选不会部分入库', async () => {
  const { id } = await create(); const detail = await ready(id);
  const last = detail.review.candidates.at(-1).document;
  expect((await world.call('POST', '/v1/datasets', world.b.operator.token, last)).status).toBe(201);
  const applied = await world.call('POST', `/v1/agent-jobs/${id}/apply`, world.b.operator.token, { revision: detail.job.revision, confirmed: true });
  expect(applied.status, applied.raw).toBe(409);
  expect((await world.call('GET', `/v1/datasets/${id}-1`, world.b.operator.token)).status).toBe(404);
  expect((await world.call('GET', `/v1/agent-jobs/${id}`, world.b.operator.token)).body.job.status).toBe('needsReview');
});
it('任务、原件、单元格、修改和应用均隔离租户；取消后不能继续应用', async () => {
  const { id } = await create(); const detail = await ready(id);
  for (const suffix of ['', '/source', '/cells']) expect((await world.call('GET', `/v1/agent-jobs/${id}${suffix}`, world.a.operator.token)).status).toBe(404);
  for (const [suffix, body] of [['cancel', {}], ['review', { revision: 1, item: 0, document: {}, reason: 'test' }], ['apply', { revision: 1, confirmed: true }]] as const) {
    expect((await world.call('POST', `/v1/agent-jobs/${id}/${suffix}`, world.a.operator.token, body)).status).toBe(404);
  }
  expect((await world.call('GET', '/v1/agent-jobs', world.a.operator.token)).raw).not.toContain(id);
  expect((await world.call('POST', `/v1/agent-jobs/${id}/cancel`, world.b.operator.token)).body.job.status).toBe('cancelled');
  expect((await world.call('POST', `/v1/agent-jobs/${id}/apply`, world.b.operator.token, { revision: detail.job.revision, confirmed: true })).status).toBe(409);
});

it('运行中取消会停止执行；过期租约只标失败，不自动再次调用模型', async () => {
  await worker.stop();
  let stopped = false, calls = 0;
  worker = startAgentWorker({ backend, pollMs: 20, extract: async ({ signal }) => {
    calls++;
    await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
    stopped = true; throw new Error('cancelled');
  } });
  const { id } = await create();
  await expect.poll(() => calls).toBe(1);
  expect((await world.call('POST', `/v1/agent-jobs/${id}/cancel`, world.b.operator.token)).body.job.status).toBe('cancelled');
  await expect.poll(() => stopped, { timeout: 5000 }).toBe(true);
  await worker.stop();
  expect((await world.call('GET', `/v1/agent-jobs/${id}`, world.b.operator.token)).body.job.status).toBe('cancelled');
  expect((await world.call('GET', `/v1/datasets/${id}-1`, world.b.operator.token)).status).toBe(404);
  const expired = await create();
  const store = backend.tenant(world.b.id).storage.agentJobs, queued = (await store.get(expired.id))!;
  await store.save(advanceJob(queued, { status: 'running', lease: { token: randomUUID(), until: '2020-01-01T00:00:00.000Z' } }, '模拟进程中断'), queued.revision);
  worker = startAgentWorker({ backend, pollMs: 20, extract: async () => { calls++; throw new Error('不应自动重跑'); } });
  await expect.poll(async () => (await store.get(expired.id))?.status, { timeout: 5000 }).toBe('failed');
  expect(calls).toBe(1);
});

});
}
