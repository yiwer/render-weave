/**
 * 存储接口合同（ADR-0018）：工作区文档、版本化资源仓库与出图记录。
 * 本地文件、内存（test/storage-contract.test.ts）与服务端的 PostgreSQL 加 S3（service/test）实现跑同一组用例。
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  deliverBatchItem, freezeBatch, loadWorkspace, ProblemCodes, readBatchFrom, readRecord, readWorkspaceDocuments, replayRecord, runFrozenBatch,
  type BatchOutput, type BatchSnapshot, type BatchSource, type RecordSource, type ResourceVersionBackend, type VersionedResourceInfo,
  type VersionedResourceStore,
} from '../../src/index.js';
import { greetingRequest, m402Dir, resourcesDir, singleTextDir } from './fixtures.js';

/** 一种存储实现：每次调用都给出一份新的、互不相干的存储。 */
export interface StorageHarness {
  readonly name: string;
  documents(dir: string): Promise<Parameters<typeof readWorkspaceDocuments>[0]>;
  resources(): Promise<{ backend: ResourceVersionBackend; corrupt(info: VersionedResourceInfo): Promise<void> }>;
  batch(): Promise<{ output: BatchOutput; source: BatchSource; record(index: number): RecordSource }>;
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const text = (value: string) => new Uint8Array(Buffer.from(value));

/** 把测试资源仓库的全部资源作为 v1 提交。 */
async function importFixtures(backend: ResourceVersionBackend): Promise<VersionedResourceStore> {
  const legacy = JSON.parse(await fs.readFile(join(resourcesDir, 'resources.json'), 'utf8'));
  const changes = await Promise.all(legacy.resources.map(async (item: { id: string; kind: 'image' | 'font'; file: string }) =>
    ({ type: 'create' as const, id: item.id, kind: item.kind, bytes: new Uint8Array(await fs.readFile(join(resourcesDir, item.file))) })));
  expect((await backend.commit(changes)).problems).toEqual([]);
  const opened = await backend.open();
  expect(opened.problems).toEqual([]);
  return opened.store!;
}

/** 问候牌批次：前几项正常，可选追加一项引用不存在的数据集。 */
function greetingBatch(ids: string[], missing?: string) {
  const { template, mode, ...item } = greetingRequest({ output: { width: 160, height: 40, dpi: 30, format: 'png' } });
  return { template, mode, items: [...ids.map((id) => ({ id, ...item })), ...(missing ? [{ id: missing, ...item, dataset: { id: 'ds-missing' } }] : [])] };
}

export function describeStorageContract(harnesses: readonly StorageHarness[]): void {
  describe.each(harnesses)('存储接口合同：$name', (harness) => {
    it('工作区文档：读出的定义、编译产物、模板与数据集与从本地目录加载的一致', async () => {
      const { staticSchemas, templates, datasets, problems } = await loadWorkspace({ dir: m402Dir, resourcesDir });
      expect(await readWorkspaceDocuments(await harness.documents(m402Dir))).toEqual({ staticSchemas, templates, datasets, problems });
    });

    it('资源：整批提交；按预期版本追加；重复新建或预期版本过期时整批不生效，已打开的快照不变', async () => {
      const { backend } = await harness.resources();
      const first = await backend.commit([{ type: 'create', id: 'photo', kind: 'image', bytes: text('a') }, { type: 'create', id: 'font', kind: 'font', bytes: text('b') }]);
      expect(first.problems).toEqual([]);
      expect(first.committed?.map(({ id, version }) => [id, version])).toEqual([['photo', 1], ['font', 1]]);
      const before = (await backend.open()).store!;
      const v1 = before.get('photo')!;
      expect(v1).toEqual({ id: 'photo', kind: 'image', version: 1, sha256: sha256(text('a')), byteLength: 1 });
      expect(await before.read('photo', 1)).toEqual(text('a'));

      const duplicate = await backend.commit([{ type: 'create', id: 'logo', kind: 'image', bytes: text('c') }, { type: 'create', id: 'photo', kind: 'image', bytes: text('d') }]);
      expect(duplicate.committed).toBeUndefined();
      expect(duplicate.problems[0]).toMatchObject({ level: 'severe', code: ProblemCodes.inputDuplicate });
      expect((await backend.open()).store!.get('logo')).toBeUndefined();

      const appended = await backend.commit([{ type: 'append', id: 'photo', expected: v1, bytes: text('e') }]);
      expect(appended.problems).toEqual([]);
      expect(appended.committed?.[0]).toMatchObject({ id: 'photo', kind: 'image', version: 2, sha256: sha256(text('e')) });
      const stale = await backend.commit([{ type: 'append', id: 'photo', expected: v1, bytes: text('f') }]);
      expect(stale.problems[0]).toMatchObject({ level: 'severe', code: ProblemCodes.resourceReplacementStale });
      const missing = await backend.commit([{ type: 'append', id: 'nothing', expected: v1, bytes: text('g') }]);
      expect(missing.problems[0]).toMatchObject({ level: 'severe', code: ProblemCodes.resourceReplacementStale });
      const refused = await backend.commit([{ type: 'append', id: 'photo', expected: (await backend.open()).store!.get('photo')!, bytes: text('h') }],
        { beforeCommit: async () => { throw new Error('提交前条件已变化'); } });
      expect(refused.committed).toBeUndefined();
      expect(refused.problems[0]?.level).toBe('severe');

      const after = (await backend.open()).store!;
      expect(after.get('photo')?.version).toBe(2);
      expect(await after.read('photo', 1)).toEqual(text('a'));
      expect(await after.read('photo', 2)).toEqual(text('e'));
      expect(before.get('photo')?.version).toBe(1);
    });

    it('资源：内容字节被改动时，按版本读取报完整性问题', async () => {
      const { backend, corrupt } = await harness.resources();
      expect((await backend.commit([{ type: 'create', id: 'photo', kind: 'image', bytes: text('a') }])).problems).toEqual([]);
      const store = (await backend.open()).store!;
      await corrupt(store.get('photo')!);
      await expect(store.read('photo', 1)).rejects.toMatchObject({ resourceId: 'photo', code: ProblemCodes.resourceIntegrityMismatch });
    });

    describe('出图记录', () => {
      let store: VersionedResourceStore;
      let snapshot: BatchSnapshot;
      const contents = (info: VersionedResourceInfo) => store.read(info.id, info.version);
      beforeAll(async () => {
        store = await importFixtures((await harness.resources()).backend);
        const workspace = await readWorkspaceDocuments(await harness.documents(singleTextDir));
        const frozen = await freezeBatch({ workspace, resources: store, request: greetingBatch(['a', 'b'], 'c') });
        expect(frozen.problems).toEqual([]);
        snapshot = frozen.snapshot!;
      });

      it('批次快照可以序列化往返；按往返后的快照交付单项，结果与原快照相同', async () => {
        const copy: BatchSnapshot = JSON.parse(JSON.stringify(snapshot));
        expect(copy).toEqual(snapshot);
        const one = await harness.batch(), two = await harness.batch();
        const original = await deliverBatchItem({ snapshot, index: 1, contents, output: one.output });
        const restored = await deliverBatchItem({ snapshot: copy, index: 1, contents, output: two.output });
        const { directory: _a, ...expected } = original.item;
        const { directory: _b, ...actual } = restored.item;
        expect(actual).toEqual(expected);
        expect(actual).toMatchObject({ index: 1, id: 'a', status: 'delivered', severe: 0 });
        for (const file of ['record.json', 'image.png', 'input.json']) expect(await two.record(1).read(file)).toEqual(await one.record(1).read(file));
      });

      it('整批交付后能读批次与记录、能重放；单项失败不影响其他项', async () => {
        const target = await harness.batch();
        const result = await runFrozenBatch({ snapshot, contents, output: target.output });
        expect(result.problems).toEqual([]);
        expect(result.summary).toMatchObject({ total: 3, delivered: 2, failed: 1, notRun: 0 });
        expect(result.items.map((item) => item.status)).toEqual(['delivered', 'delivered', 'failed']);

        const reading = await readBatchFrom(target.source);
        expect(reading.problems).toEqual([]);
        expect(reading.batch).toMatchObject({ state: 'finished', manifest: { summary: result.summary, mode: 'final', template: '问候牌' } });

        const record = await readRecord(target.record(2));
        expect(record.problems).toEqual([]);
        expect(record.record).toMatchObject({ format: 'renderweave-output-record/1', itemId: 'b', build: snapshot.build });
        const replayed = await replayRecord(target.record(2));
        expect(replayed.problems).toEqual([]);
        expect(replayed.replayed?.files.get('image.png')).toEqual(await target.record(2).read('image.png'));
        expect(replayed.replayed?.manifest).toMatchObject({ format: 'renderweave-replay/1', itemId: 'b', matched: true });
      });

      it('记录文件被改动时，读取与重放都报完整性问题', async () => {
        const target = await harness.batch();
        expect((await deliverBatchItem({ snapshot, index: 1, contents, output: target.output })).item.status).toBe('delivered');
        const inner = target.record(1);
        const tampered: RecordSource = { location: inner.location, read: async (file) => file === 'image.png' ? text('tampered') : inner.read(file) };
        expect((await readRecord(tampered)).problems[0]).toMatchObject({ level: 'severe', code: ProblemCodes.recordIntegrityMismatch });
        expect((await replayRecord(tampered)).problems[0]).toMatchObject({ level: 'severe', code: ProblemCodes.recordIntegrityMismatch });
      });

      it('批次清单发布前，按各项已发布的完成清单辨认已交付的项', async () => {
        const target = await harness.batch();
        for (const index of [1, 3]) await deliverBatchItem({ snapshot, index, contents, output: target.output });
        const reading = await readBatchFrom(target.source);
        expect(reading.problems).toEqual([]);
        expect(reading.batch?.state).toBe('unfinished');
        const items = reading.batch?.state === 'unfinished' ? reading.batch.items : [];
        expect(items.map(({ index, status, id }) => ({ index, status, id }))).toEqual([
          { index: 1, status: 'delivered', id: 'a' },
          { index: 3, status: 'incomplete', id: undefined },
        ]);
        expect(items[0]?.directory).toBe(target.output.location(1));
      });
    });
  });
}
