/**
 * 平台管理页的汇总（P1 票据 12，验收 A10）：只经开放 API 驱动，断言服务健康、各租户的套餐与本月用量、成员数，以及记进每个租户的审计。
 * 同一组用例跑两种后端：内存后端进 npm test，PostgreSQL 加 S3 后端在 Docker 后端测试里跑（Compose 里的 worker 可能已经交付了这一项，所以已用加预占一起断言）。
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ServiceBackend } from '../src/backend.js';
import { createWorld, type World } from './api-suite.js';
import { seedGreeting } from './seed.js';

const OUTPUT = { width: 160, height: 40, dpi: 120, format: 'png' };

export function describePlatform(name: string, makeBackend: () => Promise<ServiceBackend>): void {
  describe(`平台管理页的汇总（${name}）`, () => {
    let world: World, backend: ServiceBackend;
    beforeAll(async () => {
      backend = await makeBackend();
      world = await createWorld(backend);
    });
    const overview = async () => {
      const reply = await world.call('GET', '/v1/platform/overview', world.platform);
      expect(reply.status, reply.raw.slice(0, 300)).toBe(200);
      return reply.body;
    };

    it('每个租户的套餐、本月出图、本月 Agent token 与启用的成员数；新租户没设套餐时限额是 0', async () => {
      const fresh = await world.call('POST', '/v1/platform/tenants', world.platform, { name: `新租户 ${randomUUID().slice(0, 8)}` });
      const row = async (id: string) => (await overview()).tenants.find((tenant: any) => tenant.id === id);
      expect(await row(fresh.body.id)).toEqual({
        id: fresh.body.id, name: fresh.body.name, createdAt: fresh.body.createdAt,
        plan: fresh.body.plan, images: { limit: 0, used: 0, reserved: 0, remaining: 0 },
        tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, members: 0,
      });

      const { id } = (await world.call('POST', '/v1/platform/tenants', world.platform, { name: `有用量 ${randomUUID().slice(0, 8)}` })).body as { id: string };
      const plan = { monthlyImages: 10, maxPixels: 1_000_000, concurrency: 3 };
      expect((await world.call('PUT', `/v1/platform/tenants/${id}/plan`, world.platform, plan)).status).toBe(200);
      const admin = await world.member(id, 'admin'), operator = await world.member(id, 'operator');
      await world.member(id, 'operator');
      // 停用的成员不算。
      expect((await world.call('PATCH', `/v1/members/${operator.id}`, admin.token, { active: false })).status).toBe(200);
      const storage = backend.tenant(id).storage;
      await seedGreeting(storage);
      // 代建的一轮：推送时随附，记为 token 用量。
      await storage.push(async () => ({ documents: [], templates: [], resources: [],
        rounds: [{ sha256: 'a'.repeat(64), task: '汇总', round: 1, tokens: { inputTokens: 100, outputTokens: 20 } }] }), { pushedBy: '测试', now: new Date() });
      const batch = await world.call('POST', '/v1/batches', admin.token, { template: '问候牌', items: [{ id: '1', dataset: { id: 'ds-greeting' }, output: OUTPUT }] });
      expect(batch.status, batch.raw.slice(0, 300)).toBe(202);

      const found = await row(id);
      expect(found).toMatchObject({ plan, members: 2, tokens: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 } });
      expect(found.images.limit).toBe(10);
      expect(found.images.used + found.images.reserved).toBe(1);
      expect(found.images.remaining).toBe(9);
    });

    it('服务健康：就绪与检查项、按构建的 worker 报到数、队列积压；没有报到的 worker 不列', async () => {
      const build = `sha256:${randomUUID()}`;
      await backend.workers.heartbeat(`worker-${randomUUID()}`, build, world.clock.value);
      const { service, period } = await overview();
      expect(period).toMatch(/^\d{4}-\d{2}$/);
      expect(service).toMatchObject({ ready: true, checks: expect.any(Object) });
      expect(service.workers).toContainEqual({ build, workers: 1 });
      expect(service.queue).toMatchObject({ queued: { preview: expect.any(Number), batchItem: expect.any(Number), replay: expect.any(Number) },
        running: expect.any(Object), oldestQueuedMs: expect.any(Number) });
      const worker = `worker-${randomUUID()}`, gone = `sha256:${randomUUID()}`;
      await backend.workers.heartbeat(worker, gone, world.clock.value);
      await backend.workers.leave(worker);
      expect((await overview()).service.workers.map((entry: any) => entry.build)).not.toContain(gone);
    });

    it('读到了各租户的用量，所以记进每个租户的审计，标为跨租户；不含别的租户的信息', async () => {
      await overview();
      const events = (await world.call('GET', '/v1/audit-events?limit=500', world.a.admin.token)).body.events as any[];
      const [read] = events.filter((event) => event.action === 'overview.read');
      expect(read).toMatchObject({ tenantId: world.a.id, actor: { kind: 'platformUser' }, object: { type: 'tenant', id: world.a.id }, crossTenant: true });
      expect(JSON.stringify(events)).not.toContain(world.b.id);
    });
  });
}
