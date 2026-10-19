/**
 * 存储接口合同（ADR-0018）的本地文件实现与内存实现；用例在 test/support/storage-contract.ts，
 * 服务端的 PostgreSQL 加 S3 实现在 service/test 跑同一组用例（Docker 后端，不进 npm test）。
 */
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect } from 'vitest';
import {
  createLocalBatchOutput, createMemoryBatch, createMemoryResourceBackend, initializeResourceStore,
  localBatchSource, localRecordSource, localResourceBackend, localWorkspaceDocuments, memoryWorkspaceDocuments,
} from '../src/index.js';
import { describeStorageContract, type StorageHarness } from './support/storage-contract.js';

let root: string;
let sequence = 0;
const next = (prefix: string) => join(root, `${prefix}-${++sequence}`);
const text = (value: string) => new Uint8Array(Buffer.from(value));
const pad = (index: number) => String(index).padStart(4, '0');

const local: StorageHarness = {
  name: '本地文件',
  documents: async (dir) => localWorkspaceDocuments(dir),
  async resources() {
    const dir = next('resources');
    expect((await initializeResourceStore(dir)).problems).toEqual([]);
    return {
      backend: localResourceBackend(dir),
      async corrupt(info) {
        const manifest = JSON.parse(await fs.readFile(join(dir, 'resources.json'), 'utf8'));
        const entry = manifest.resources.find((item: { id: string }) => item.id === info.id);
        await fs.writeFile(join(dir, entry.versions[info.version - 1].file), 'corrupt');
      },
    };
  },
  async batch() {
    const dir = next('batch');
    return { output: await createLocalBatchOutput(dir), source: localBatchSource(dir), record: (index) => localRecordSource(join(dir, pad(index))) };
  },
};

const memory: StorageHarness = {
  name: '内存',
  async documents(dir) {
    const names = (await fs.readdir(dir)).filter((file) => file.endsWith('.json')).sort();
    return memoryWorkspaceDocuments(await Promise.all(names.map(async (file) =>
      ({ source: join(dir, file), bytes: new Uint8Array(await fs.readFile(join(dir, file))) }))));
  },
  async resources() {
    const contents = new Map<string, Uint8Array>();
    return { backend: createMemoryResourceBackend({ contents }), corrupt: async (info) => { contents.set(info.sha256, text('corrupt')); } };
  },
  async batch() {
    const batch = createMemoryBatch();
    return { output: batch.output, source: batch.batch, record: (index) => batch.record(index) };
  },
};

beforeAll(async () => { root = await fs.mkdtemp(join(tmpdir(), 'renderweave-storage-')); });
afterAll(async () => {
  if (!resolve(root).startsWith(join(resolve(tmpdir()), 'renderweave-storage-'))) throw new Error('测试清理路径越界');
  await fs.rm(root, { recursive: true, force: true });
});

describeStorageContract([local, memory]);
