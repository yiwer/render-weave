/**
 * 迁移之后的数据步骤（M389）：要读对象存储、SQL 做不了的存量补写。迁移在 pending_data_steps 里留一个标记，部署步骤全部做完才删；
 * 接口进程等部署步骤结束才启动，这期间没有别的写入，中途失败重跑一遍也不会多写。
 */
import type { ServiceBackend, TenantStorage } from '../backend.js';
import { definitionsFromStatics } from '../push.js';
import type { Db } from './db.js';

/** 只有静态版本、还没有数据定义的名称补一个数据定义，内容是最新版本去掉版本号（ADR-0030）。答补了几个。 */
export async function backfillDefinitions(storage: TenantStorage): Promise<number> {
  const existing = new Set((await storage.definitions()).map((definition) => definition.name));
  const statics = (await storage.authoringState()).documents.filter((stored) => stored.kind === 'definition');
  const missing = await definitionsFromStatics(statics, storage.contents, (name) => !existing.has(name));
  let created = 0;
  for (const { name, bytes } of missing) {
    if (await storage.createDefinition({ name, bytes }, { updatedBy: '部署步骤', now: new Date() })) created++;
  }
  return created;
}

/** 做完迁移留下的数据步骤；没有就什么也不做。 */
export async function runPendingDataSteps(owner: Pick<Db, 'query'>, backend: ServiceBackend, log: (message: string, details: Record<string, unknown>) => void): Promise<void> {
  const { rows } = await owner.query<{ step: string }>('SELECT step FROM pending_data_steps');
  if (!rows.some((row) => row.step === 'definitions-backfill')) return;
  let created = 0;
  const tenants = await backend.platform.listTenants();
  for (const tenant of tenants) created += await backfillDefinitions(backend.tenant(tenant.id).storage);
  await owner.query(`DELETE FROM pending_data_steps WHERE step = 'definitions-backfill'`);
  log('存量的数据定义已补齐', { tenants: tenants.length, created });
}
