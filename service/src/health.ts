/**
 * 健康检查：存活只说明进程在响应；就绪要求数据库可连、迁移与代码一致、对象存储可列举。
 * 结果只写检查项与简短原因，不带连接串或凭据。
 */
import type { BlobStore } from './blobs.js';
import type { Db } from './db.js';
import { checkMigrations, type Migration } from './migrate.js';

export interface Readiness {
  readonly ready: boolean;
  readonly schemaVersion?: number;
  readonly checks: { readonly database: string; readonly migrations: string; readonly storage: string };
}

export async function readiness(db: Db, blobs: BlobStore, migrations: readonly Migration[]): Promise<Readiness> {
  let database = 'ok', schema = 'ok', schemaVersion: number | undefined;
  try {
    await db.query('SELECT 1');
    const state = await checkMigrations(db, migrations);
    schemaVersion = state.version;
    if (state.problems.length) schema = state.problems.join('；');
    else if (state.pending.length) schema = `还有未执行的迁移：${state.pending.join('、')}`;
  } catch (error) {
    database = `数据库不可用：${(error as Error).message}`;
    schema = '未检查';
  }
  const storage = (await blobs.available()) ? 'ok' : '对象存储不可用';
  return { ready: database === 'ok' && schema === 'ok' && storage === 'ok', ...(schemaVersion === undefined ? {} : { schemaVersion }), checks: { database, migrations: schema, storage } };
}
