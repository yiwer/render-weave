/**
 * 计量与额度在 PostgreSQL 里的读写（票据 09，ADR-0020）：都在调用方的租户事务里执行，行级安全照常生效。
 * 锁的顺序一律是先批次行、后计数行；建批次时先锁计数行，再插入新的批次行，不会和别的事务互相等待。
 */
import { DEFAULT_PLAN, periodOf, TOKEN_KINDS, type Plan, type RoundUsageEntry, type TokenKind, type UsageCounts } from '../backend.js';
import type { DbClient } from './db.js';

export async function readPlan(client: DbClient, tenantId: string): Promise<Plan> {
  const [row] = (await client.query<{ monthly_images: number; max_pixels: string; concurrency: number }>(
    'SELECT monthly_images, max_pixels, concurrency FROM tenant_plans WHERE tenant_id = $1', [tenantId])).rows;
  return row ? { monthlyImages: row.monthly_images, maxPixels: Number(row.max_pixels), concurrency: row.concurrency } : DEFAULT_PLAN;
}

/** 当期计数行：没有就按套餐建，然后锁住。 */
export async function lockCounter(client: DbClient, tenantId: string, period: string): Promise<{ limit: number; used: number; reserved: number }> {
  await client.query(`INSERT INTO usage_counters (tenant_id, period, image_limit)
    VALUES ($1, $2, coalesce((SELECT monthly_images FROM tenant_plans WHERE tenant_id = $1), $3)) ON CONFLICT (tenant_id, period) DO NOTHING`,
  [tenantId, period, DEFAULT_PLAN.monthlyImages]);
  const row = (await client.query<{ image_limit: number; used: number; reserved: number }>(
    'SELECT image_limit, used, reserved FROM usage_counters WHERE tenant_id = $1 AND period = $2 FOR UPDATE', [tenantId, period])).rows[0]!;
  return { limit: row.image_limit, used: row.used, reserved: row.reserved };
}

/** 锁住批次行，读它的周期与剩余预占；不计量的批次（没有周期）返回 undefined。 */
async function meteredBatch(client: DbClient, tenantId: string, batchId: string): Promise<{ period: string; reserved: number } | undefined> {
  const [row] = (await client.query<{ period: string | null; reserved: number }>(
    'SELECT period, reserved FROM batches WHERE tenant_id = $1 AND batch_id = $2 FOR NO KEY UPDATE', [tenantId, batchId])).rows;
  return row?.period ? { period: row.period, reserved: row.reserved } : undefined;
}

/**
 * 结算一项：与登记这一项（batch_items）同一个事务（ADR-0019、ADR-0020）。交付成功的计 1 张、记一条用量事件；
 * 有预占就退 1。"批次加项序号"唯一，所以同一项只会结算一次。
 */
export async function settleItem(client: DbClient, tenantId: string, batchId: string, index: number, delivered: boolean): Promise<void> {
  const batch = await meteredBatch(client, tenantId, batchId);
  if (!batch) return;
  const release = batch.reserved > 0 ? 1 : 0;
  if (release) await client.query('UPDATE batches SET reserved = reserved - 1 WHERE tenant_id = $1 AND batch_id = $2', [tenantId, batchId]);
  if (!release && !delivered) return;
  await lockCounter(client, tenantId, batch.period);
  await client.query('UPDATE usage_counters SET used = used + $3, reserved = greatest(reserved - $4, 0) WHERE tenant_id = $1 AND period = $2',
    [tenantId, batch.period, delivered ? 1 : 0, release]);
  if (delivered) {
    await client.query(`INSERT INTO usage_events (tenant_id, period, kind, quantity, batch_id, item_index, at) VALUES ($1, $2, 'image', 1, $3, $4, now())`,
      [tenantId, batch.period, batchId, index]);
  }
}

/** 退回批次的预占：count 项，或剩下的全部；不超过批次剩余的预占。返回退回的数目。 */
export async function releaseReserved(client: DbClient, tenantId: string, batchId: string, count: number | 'all'): Promise<number> {
  const batch = await meteredBatch(client, tenantId, batchId);
  if (!batch) return 0;
  const released = count === 'all' ? batch.reserved : Math.min(count, batch.reserved);
  if (released <= 0) return 0;
  await client.query('UPDATE batches SET reserved = reserved - $3 WHERE tenant_id = $1 AND batch_id = $2', [tenantId, batchId, released]);
  await client.query('UPDATE usage_counters SET reserved = greatest(reserved - $3, 0) WHERE tenant_id = $1 AND period = $2', [tenantId, batch.period, released]);
  return released;
}

/** 推送随附的代建轮次记为用量事件（周期按推送的时间）；同一轮的同一种 token 只记一次。返回这次新记的轮次。 */
export async function recordRounds(client: DbClient, tenantId: string, rounds: readonly RoundUsageEntry[], now: Date): Promise<string[]> {
  const recorded: string[] = [];
  for (const round of rounds) {
    let added = false;
    for (const kind of TOKEN_KINDS) {
      const quantity = round.tokens[kind];
      if (!quantity) continue;
      const inserted = await client.query(`INSERT INTO usage_events (tenant_id, period, kind, quantity, round_sha256, round_task, round_number, at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (tenant_id, round_sha256, kind) WHERE round_sha256 IS NOT NULL DO NOTHING`,
      [tenantId, periodOf(now), kind, quantity, round.sha256, round.task, round.round, now]);
      added ||= inserted.rowCount === 1;
    }
    if (added) recorded.push(round.sha256);
  }
  return recorded;
}

/** 一个周期的计数：没有计数行时限额取当前套餐。 */
export async function usageCounts(client: DbClient, tenantId: string, period: string): Promise<UsageCounts> {
  const [row] = (await client.query<{ image_limit: number; used: number; reserved: number }>(
    'SELECT image_limit, used, reserved FROM usage_counters WHERE tenant_id = $1 AND period = $2', [tenantId, period])).rows;
  const tokens = Object.fromEntries(TOKEN_KINDS.map((kind) => [kind, 0])) as Record<TokenKind, number>;
  for (const sum of (await client.query<{ kind: TokenKind; total: string }>(
    `SELECT kind, sum(quantity) AS total FROM usage_events WHERE tenant_id = $1 AND period = $2 AND kind <> 'image' GROUP BY kind`, [tenantId, period])).rows) {
    tokens[sum.kind] = Number(sum.total);
  }
  return { period, limit: row ? row.image_limit : (await readPlan(client, tenantId)).monthlyImages, used: row?.used ?? 0, reserved: row?.reserved ?? 0, tokens };
}
