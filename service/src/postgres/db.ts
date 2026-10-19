/**
 * PostgreSQL 连接池与事务。数据库事务是唯一的提交点（ADR-0018）。
 * 接口进程与 worker 用应用账号连库，行级安全对它生效：租户数据只在 withTenant 里可见，
 * 平台级操作在 asPlatform 里进行；两样都没设置时什么也查不到（M262）。
 */
import pg from 'pg';

export type Db = pg.Pool;
export type DbClient = pg.PoolClient;

export function createDb(url: string): Db {
  return new pg.Pool({ connectionString: url, max: 10 });
}

/** 在一个事务里执行；抛错即回滚。 */
export async function transaction<T>(db: Db, run: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** 本事务只看得到这个租户的行。设置只在事务内有效，连接还回池里后不残留。 */
export function withTenant<T>(db: Db, tenantId: string, run: (client: DbClient) => Promise<T>): Promise<T> {
  return transaction(db, async (client) => {
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    return run(client);
  });
}

/** 平台级操作：建租户、平台用户的会话与审计、代建令牌。对租户数据表无效。 */
export function asPlatform<T>(db: Db, run: (client: DbClient) => Promise<T>): Promise<T> {
  return transaction(db, async (client) => {
    await client.query(`SELECT set_config('app.platform', 'on', true)`);
    return run(client);
  });
}

/** 违反唯一约束。 */
export const isUniqueViolation = (error: unknown) => (error as { code?: string } | undefined)?.code === '23505';
