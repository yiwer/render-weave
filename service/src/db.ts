/** PostgreSQL 连接池与事务。数据库事务是唯一的提交点（ADR-0018）。 */
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

/** 违反唯一约束。 */
export const isUniqueViolation = (error: unknown) => (error as { code?: string } | undefined)?.code === '23505';
