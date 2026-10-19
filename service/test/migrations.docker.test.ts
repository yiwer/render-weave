/**
 * 数据库迁移（M259）：按版本号顺序执行，启动时检查。每个用例在自己的临时数据库里进行。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDb, type Db } from '../src/postgres/db.js';
import { checkMigrations, loadMigrations, migrate, waitForMigrations, type Migration } from '../src/postgres/migrate.js';
import { connectOwner, databaseUrl, ownerUrl } from './support.js';

let admin: Db, dir: string;
const created: string[] = [], pools: Db[] = [];

beforeAll(async () => {
  admin = connectOwner();
  dir = await mkdtemp(join(tmpdir(), 'renderweave-migrations-'));
});
afterAll(async () => {
  await Promise.all(pools.map((pool) => pool.end()));
  for (const name of created) await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.end();
  await rm(dir, { recursive: true, force: true });
});

async function freshDatabase(): Promise<Db> {
  const name = `rw_migrations_${created.length + 1}_${process.pid}`;
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.query(`CREATE DATABASE ${name}`);
  created.push(name);
  const pool = createDb(databaseUrl(ownerUrl, name));
  pools.push(pool);
  return pool;
}

async function migrationDir(files: Record<string, string>): Promise<string> {
  const target = await mkdtemp(join(dir, 'set-'));
  for (const [file, sql] of Object.entries(files)) await writeFile(join(target, file), sql);
  return target;
}

it('仓库里的迁移从 1 连续编号；空数据库上按顺序全部执行，再次启动不重复执行', async () => {
  const migrations = await loadMigrations();
  expect(migrations.map((m: Migration) => m.version)).toEqual(migrations.map((_m: Migration, i: number) => i + 1));
  const db = await freshDatabase();
  expect((await checkMigrations(db, migrations)).pending).toEqual(migrations.map((m) => m.version));
  const first = await migrate(db, migrations);
  expect(first).toMatchObject({ version: migrations.length, pending: [], problems: [], applied: migrations.map((m) => m.version) });
  expect((await migrate(db, migrations)).applied).toEqual([]);
  const rows = (await db.query('SELECT version, name FROM schema_migrations ORDER BY applied_at, version')).rows;
  expect(rows.map((row) => row.version)).toEqual(migrations.map((m) => m.version));
});

it('按版本号顺序执行：后面的迁移依赖前面建的表', async () => {
  const set = await loadMigrations(await migrationDir({
    '0002_add_column.sql': 'ALTER TABLE things ADD COLUMN label text;',
    '0001_create.sql': 'CREATE TABLE things (id integer PRIMARY KEY);',
  }));
  expect(set.map((m) => [m.version, m.name])).toEqual([[1, 'create'], [2, 'add_column']]);
  const db = await freshDatabase();
  expect((await migrate(db, set)).applied).toEqual([1, 2]);
  await db.query(`INSERT INTO things (id, label) VALUES (1, '有')`);
});

it('版本号不连续或文件名不合规时不加载', async () => {
  await expect(loadMigrations(await migrationDir({ '0001_a.sql': 'SELECT 1;', '0003_c.sql': 'SELECT 1;' }))).rejects.toThrow(/连续/);
  await expect(loadMigrations(await migrationDir({ '1_a.sql': 'SELECT 1;' }))).rejects.toThrow(/NNNN_名称/);
});

it('一个迁移失败时它整体回滚，版本停在前一个', async () => {
  const set = await loadMigrations(await migrationDir({
    '0001_ok.sql': 'CREATE TABLE ok (id integer);',
    '0002_broken.sql': 'CREATE TABLE half (id integer); SELECT * FROM missing_table;',
  }));
  const db = await freshDatabase();
  await expect(migrate(db, set)).rejects.toThrow(/迁移 2（broken）执行失败/);
  expect((await checkMigrations(db, set))).toMatchObject({ version: 1, pending: [2] });
  expect((await db.query(`SELECT to_regclass('half') IS NULL AS absent`)).rows[0].absent).toBe(true);
});

it('启动时检查：已执行的迁移被改过，或数据库有代码不认识的版本，都拒绝启动，也不执行任何迁移', async () => {
  const set = await loadMigrations(await migrationDir({ '0001_a.sql': 'CREATE TABLE a (id integer);' }));
  const db = await freshDatabase();
  await migrate(db, set);
  const edited: Migration[] = [{ ...set[0]!, sha256: '0'.repeat(64) }];
  expect((await checkMigrations(db, edited)).problems[0]).toMatch(/被改动/);
  await expect(migrate(db, edited)).rejects.toThrow(/被改动/);
  expect((await checkMigrations(db, [])).problems[0]).toMatch(/不认识/);
  await expect(waitForMigrations(db, [], 1_000)).rejects.toThrow(/不认识/);
});

it('接口进程与 worker 等部署步骤执行迁移：迁移完成前等待，完成后启动', async () => {
  const set = await loadMigrations(await migrationDir({ '0001_a.sql': 'CREATE TABLE a (id integer);' }));
  const db = await freshDatabase();
  await expect(waitForMigrations(db, set, 500)).rejects.toThrow(/等待迁移：1/);
  const waiting = waitForMigrations(db, set, 10_000);
  await migrate(db, set);
  await expect(waiting).resolves.toBe(1);
});
