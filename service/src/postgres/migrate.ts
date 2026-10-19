/**
 * 数据库迁移（M259）：service/migrations 下的 NNNN_名称.sql，版本号从 1 连续递增，按顺序各在一个事务里执行。
 * 部署步骤 setup 用属主账号执行，咨询锁避免多个进程同时迁移；接口进程与 worker 启动时只检查（M262）。
 * 已执行的迁移改了内容，或数据库里有代码不认识的版本，都拒绝启动。
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Db } from './db.js';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly sha256: string;
}

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));
/** 咨询锁的键："RWMG"。 */
const LOCK = 0x52574d47;
const FILE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export async function loadMigrations(dir = MIGRATIONS_DIR): Promise<Migration[]> {
  const migrations: Migration[] = [];
  for (const file of (await readdir(dir)).sort()) {
    const match = FILE.exec(file);
    if (!match) throw new Error(`迁移文件名必须是 NNNN_名称.sql：${file}`);
    const sql = await readFile(`${dir}/${file}`, 'utf8');
    migrations.push({ version: Number(match[1]), name: match[2]!, sql, sha256: createHash('sha256').update(sql).digest('hex') });
  }
  migrations.forEach((migration, i) => {
    if (migration.version !== i + 1) throw new Error(`迁移版本号必须从 1 连续递增：${migration.version} 处应为 ${i + 1}`);
  });
  return migrations;
}

export interface MigrationState {
  /** 数据库当前的版本；没有迁移记录时为 0。 */
  readonly version: number;
  /** 代码里有、数据库还没执行的版本。 */
  readonly pending: readonly number[];
  /** 不能启动的原因：已执行的迁移内容变了，或数据库里有代码不认识的版本。 */
  readonly problems: readonly string[];
}

const TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version integer PRIMARY KEY,
  name text NOT NULL,
  sha256 char(64) NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

async function state(db: Pick<Db, 'query'>, migrations: readonly Migration[]): Promise<MigrationState> {
  const exists = await db.query(`SELECT to_regclass('schema_migrations') IS NOT NULL AS exists`);
  const applied = exists.rows[0].exists
    ? (await db.query<{ version: number; sha256: string }>('SELECT version, sha256 FROM schema_migrations ORDER BY version')).rows
    : [];
  const known = new Map(migrations.map((migration) => [migration.version, migration]));
  const problems: string[] = [];
  for (const row of applied) {
    const migration = known.get(row.version);
    if (!migration) problems.push(`数据库已执行版本 ${row.version}，当前代码不认识它；请用更新的构建启动`);
    else if (migration.sha256 !== row.sha256) problems.push(`版本 ${row.version}（${migration.name}）执行后内容被改动；迁移只能追加，不能修改`);
  }
  const done = new Set(applied.map((row) => row.version));
  return { version: applied.at(-1)?.version ?? 0, pending: migrations.filter((m) => !done.has(m.version)).map((m) => m.version), problems };
}

/** 只检查：worker 与就绪检查用。 */
export function checkMigrations(db: Pick<Db, 'query'>, migrations: readonly Migration[]): Promise<MigrationState> {
  return state(db, migrations);
}

/** 执行尚未执行的迁移，返回执行后的状态；有不能启动的原因时抛错，不执行任何迁移。 */
export async function migrate(db: Db, migrations: readonly Migration[]): Promise<MigrationState & { readonly applied: readonly number[] }> {
  const client = await db.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK]);
    try {
      await client.query(TABLE);
      const before = await state(client, migrations);
      if (before.problems.length) throw new Error(before.problems.join('；'));
      for (const version of before.pending) {
        const migration = migrations[version - 1]!;
        await client.query('BEGIN');
        try {
          await client.query(migration.sql);
          await client.query('INSERT INTO schema_migrations (version, name, sha256) VALUES ($1, $2, $3)', [migration.version, migration.name, migration.sha256]);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw new Error(`迁移 ${migration.version}（${migration.name}）执行失败：${(error as Error).message}`);
        }
      }
      return { ...(await state(client, migrations)), applied: before.pending };
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK]);
    }
  } finally {
    client.release();
  }
}

/**
 * 接口进程与 worker 启动时等部署步骤执行完迁移；数据库有代码不认识的版本或迁移被改过时直接失败。
 * 返回数据库版本。
 */
export async function waitForMigrations(db: Pick<Db, 'query'>, migrations: readonly Migration[], timeoutMs: number,
  onWait: (reason: string) => void = () => undefined): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let current: MigrationState | undefined, reason = '';
    try { current = await checkMigrations(db, migrations); }
    catch (error) { reason = `数据库不可用：${(error as Error).message}`; }
    if (current) {
      if (current.problems.length) throw new Error(current.problems.join('；'));
      if (!current.pending.length) return current.version;
      reason = `等待迁移：${current.pending.join('、')}`;
    }
    if (Date.now() > deadline) throw new Error(`启动超时，${reason}`);
    onWait(reason);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/** 部署步骤：让应用账号能登录并设置密码（M262）。密码只经环境变量传入，不进日志。 */
export async function setAppRolePassword(db: Db, password: string): Promise<void> {
  const client = await db.connect();
  try { await client.query(`ALTER ROLE renderweave_app WITH LOGIN PASSWORD ${client.escapeLiteral(password)}`); }
  finally { client.release(); }
}
