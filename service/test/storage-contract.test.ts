/**
 * 存储接口合同的 PostgreSQL 加 S3 实现（ADR-0018、ADR-0019）：与本地文件、内存实现跑同一组用例。
 * 每次取存储都新建一个租户，互不相干；另测服务端特有的约束：对象先写、再登记，键在租户前缀下，按哈希去重。
 */
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeStorageContract, type StorageHarness } from '../../test/support/storage-contract.js';
import { blobKey, sha256Hex } from '../src/blobs.js';
import type { Db } from '../src/db.js';
import { loadMigrations, migrate } from '../src/migrate.js';
import { createTenant, tenantStorage } from '../src/storage.js';
import { blobs, config, connect, s3 } from './support.js';

let db: Db;
const tenant = async () => tenantStorage(db, blobs, await createTenant(db, 'contract'));
const text = (value: string) => new Uint8Array(Buffer.from(value));

beforeAll(async () => {
  db = connect();
  await migrate(db, await loadMigrations());
});
afterAll(async () => { await db.end(); });

const postgresS3: StorageHarness = {
  name: 'PostgreSQL 加 S3',
  async documents(dir) {
    const storage = await tenant();
    const names = (await fs.readdir(dir)).filter((file) => file.endsWith('.json'));
    await storage.putDocuments(await Promise.all(names.map(async (file) => ({ source: join(dir, file), bytes: new Uint8Array(await fs.readFile(join(dir, file))) }))));
    return storage.documents;
  },
  async resources() {
    const storage = await tenant();
    return {
      backend: storage.resources,
      async corrupt(info) {
        await s3.send(new PutObjectCommand({ Bucket: config.s3.bucket, Key: blobKey(storage.tenantId, info.sha256), Body: text('corrupt') }));
      },
    };
  },
  async batch() {
    const batch = await (await tenant()).createBatch();
    return { output: batch.output, source: batch.source, record: (index) => batch.record(index) };
  },
};

describeStorageContract([postgresS3]);

describe('PostgreSQL 加 S3 特有的约束', () => {
  const keys = async (tenantId: string) => ((await s3.send(new ListObjectsV2Command({ Bucket: config.s3.bucket, Prefix: `tenants/${tenantId}/` }))).Contents ?? [])
    .map((object) => object.Key!).sort();

  it('内容按 SHA-256 存在租户前缀下；同一租户内相同字节只存一份，不同租户各存一份', async () => {
    const first = await tenant(), second = await tenant();
    const bytes = text('同一份字体');
    expect((await first.resources.commit([{ type: 'create', id: 'a', kind: 'font', bytes }, { type: 'create', id: 'b', kind: 'font', bytes }])).problems).toEqual([]);
    expect((await second.resources.commit([{ type: 'create', id: 'a', kind: 'font', bytes }])).problems).toEqual([]);
    expect(await keys(first.tenantId)).toEqual([`tenants/${first.tenantId}/blobs/sha256/${sha256Hex(bytes)}`]);
    expect(await keys(second.tenantId)).toEqual([`tenants/${second.tenantId}/blobs/sha256/${sha256Hex(bytes)}`]);
  });

  it('文档按原始字节保存：键的顺序、重复键与数值原文都保留，读出时核对哈希', async () => {
    const storage = await tenant();
    const raw = text('{ "b": 1, "a": 0.1000000000000000055511151231257827, "a": 2 }\n');
    await storage.putDocuments([{ source: 'raw.json', bytes: raw }]);
    const [entry] = await storage.documents.list();
    expect(await entry!.read()).toEqual(raw);
    await s3.send(new PutObjectCommand({ Bucket: config.s3.bucket, Key: blobKey(storage.tenantId, sha256Hex(raw)), Body: text('{}') }));
    await expect((await storage.documents.list())[0]!.read()).rejects.toThrow(/哈希/);
  });

  it('提交点是事务：提交前条件失败时，内容对象可能已写入，但资源清单不变、读者看不到', async () => {
    const storage = await tenant();
    const refused = await storage.resources.commit([{ type: 'create', id: 'photo', kind: 'image', bytes: text('未登记') }],
      { beforeCommit: async () => { throw new Error('提交前条件已变化'); } });
    expect(refused.problems[0]?.level).toBe('severe');
    expect(await keys(storage.tenantId)).toEqual([`tenants/${storage.tenantId}/blobs/sha256/${sha256Hex(text('未登记'))}`]);
    expect((await storage.resources.open()).store!.list()).toEqual([]);
  });

  it('同一租户的并发提交依次进行：同时追加同一预期版本，只有一个成功', async () => {
    const storage = await tenant();
    expect((await storage.resources.commit([{ type: 'create', id: 'photo', kind: 'image', bytes: text('v1') }])).problems).toEqual([]);
    const expected = (await storage.resources.open()).store!.get('photo')!;
    const results = await Promise.all(['a', 'b', 'c'].map((value) => storage.resources.commit([{ type: 'append', id: 'photo', expected, bytes: text(value) }])));
    expect(results.filter((result) => result.problems.length === 0)).toHaveLength(1);
    expect(results.filter((result) => result.problems[0]?.code === 'resource.replacementStale')).toHaveLength(2);
    expect((await storage.resources.open()).store!.get('photo')?.version).toBe(2);
  });

  it('同一项只登记一次：重写同一项被拒绝，已登记的成果不变', async () => {
    const batch = await (await tenant()).createBatch();
    await batch.output.write(1, { files: new Map([['problems.json', text('[]\n')]]) });
    await expect(batch.output.write(1, { files: new Map([['problems.json', text('[1]\n')]]) })).rejects.toThrow(/已有成果/);
    expect(await batch.record(1).read('problems.json')).toEqual(text('[]\n'));
    expect(await batch.source.items()).toEqual([1]);
  });
});
