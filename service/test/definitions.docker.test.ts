/** 数据定义的用例跑 PostgreSQL 加 S3 后端（应用账号，行级安全生效），与内存后端同一组用例；另有只在 PostgreSQL 上才有的部署步骤。 */
import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';
import type { ServiceBackend } from '../src/backend.js';
import { runPendingDataSteps } from '../src/postgres/data-steps.js';
import type { Db } from '../src/postgres/db.js';
import { describeDefinitions } from './definitions-suite.js';
import { GREETING_FILES, SINGLE_TEXT, seedDocuments } from './seed.js';
import { connectOwner, postgresBackend } from './support.js';
import { readFile } from 'node:fs/promises';

const pools: Db[] = [];
afterAll(async () => { await Promise.all(pools.map((db) => db.end())); });

describeDefinitions('PostgreSQL 加 S3', async () => {
  const { db, backend } = await postgresBackend();
  pools.push(db);
  return backend;
});

it('部署步骤（M389）：有标记才补存量，补完删掉标记，再跑什么也不做；用户删掉的不会被再次运行补回来', async () => {
  const { db, backend } = await postgresBackend(), owner = connectOwner();
  pools.push(db, owner);
  const { id } = await backend.platform.createTenant(`部署步骤 ${randomUUID().slice(0, 8)}`);
  const storage = backend.tenant(id).storage;
  await seedDocuments(storage, await Promise.all(GREETING_FILES.map(async (file) => new Uint8Array(await readFile(`${SINGLE_TEXT}${file}`)))));
  const removed = await storage.deleteDefinition('问候');
  expect(removed?.name).toBe('问候');
  // 只看这一个租户：别的用例的租户不该被补。
  const scoped = { platform: { listTenants: async () => [{ id }] }, tenant: backend.tenant } as unknown as ServiceBackend;
  const logged: unknown[] = [];
  const run = () => runPendingDataSteps(owner, scoped, (message, details) => logged.push([message, details]));

  await run();
  expect(await storage.definition('问候'), '没有标记就什么也不做').toBeUndefined();

  await owner.query(`INSERT INTO pending_data_steps (step) VALUES ('definitions-backfill')`);
  await run();
  const filled = await storage.definition('问候');
  expect(filled).toMatchObject({ name: '问候', updatedBy: '部署步骤' });
  expect(JSON.parse(Buffer.from((await storage.contents.get(filled!.sha256))!).toString('utf8'))).not.toHaveProperty('version');
  expect(logged).toEqual([['存量的数据定义已补齐', { tenants: 1, created: 1 }]]);
  expect((await owner.query('SELECT step FROM pending_data_steps')).rows, '标记删掉了').toEqual([]);

  await storage.deleteDefinition('问候');
  await run();
  expect(await storage.definition('问候'), '再跑不补回来').toBeUndefined();
});
