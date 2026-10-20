/**
 * 交付批次的一项（票据 07，ADR-0019）：进程内 worker 与渲染子进程都调这一处。
 * - 这一项已登记（worker 重领了已交付的项）时沿用登记的结果，不重渲染，记录行只提交一次；
 * - 否则按批次快照交付：子进程先写对象，再在一个事务里登记这一项（引擎 deliverBatchItem 经存储接口完成）；
 * - 快照与资源内容按 SHA-256 缓存在进程里，同一批次的各项不重复读取。
 */
import type { BatchItemTask, ItemResult, TenantStorage } from './backend.js';
import { committedItem } from './batches.js';
import { deliverBatchItem, type BatchSnapshot, type VersionedResourceInfo } from './engine.js';

/** 资源内容缓存的上限：渲染子进程与渲染共用容器的内存。 */
const CONTENT_CACHE_BYTES = 128 * 1024 * 1024;
const SNAPSHOT_CACHE = 4;

export type ItemDeliverer = (storage: TenantStorage, task: BatchItemTask) => Promise<ItemResult>;

export function itemDeliverer(): ItemDeliverer {
  const snapshots = new Map<string, BatchSnapshot>();
  const contents = new Map<string, Uint8Array>();
  let cached = 0;
  const remember = <T>(map: Map<string, T>, key: string, value: T) => {
    map.delete(key);
    map.set(key, value);
  };

  const snapshotOf = async (storage: TenantStorage, sha256: string): Promise<BatchSnapshot> => {
    const hit = snapshots.get(sha256);
    if (hit) { remember(snapshots, sha256, hit); return hit; }
    const bytes = await storage.contents.get(sha256);
    if (!bytes) throw new Error(`批次快照不存在：${sha256}`);
    const snapshot = JSON.parse(Buffer.from(bytes).toString('utf8')) as BatchSnapshot;
    remember(snapshots, sha256, snapshot);
    while (snapshots.size > SNAPSHOT_CACHE) snapshots.delete(snapshots.keys().next().value!);
    return snapshot;
  };

  return async (storage, task) => {
    const batch = storage.openBatch(task.batchId);
    const existing = await committedItem(batch, task.index, task.itemId);
    if (existing) return existing;
    const snapshot = await snapshotOf(storage, task.snapshot);
    let opened: Awaited<ReturnType<TenantStorage['resources']['open']>> | undefined;
    // 按固定版本从版本仓库读资源，读取本身核对字节数与 SHA-256。
    const pinned = async (info: VersionedResourceInfo) => {
      const hit = contents.get(info.sha256);
      if (hit) { remember(contents, info.sha256, hit); return hit; }
      opened ??= await storage.resources.open();
      if (!opened.store) throw new Error(`读不到资源仓库：${opened.problems.map((p) => p.message).join('；')}`);
      const bytes = await opened.store.read(info.id, info.version);
      if (bytes.length <= CONTENT_CACHE_BYTES) {
        remember(contents, info.sha256, bytes);
        cached += bytes.length;
        for (const [key, value] of contents) {
          if (cached <= CONTENT_CACHE_BYTES) break;
          contents.delete(key);
          cached -= value.length;
        }
      }
      return bytes;
    };
    const { item, writeFailed } = await deliverBatchItem({ snapshot, index: task.index, contents: pinned, output: batch.output });
    // 写入失败可能是别的 worker 已登记了这一项（重领的竞争）：以登记的为准。
    if (writeFailed) {
      const committed = await committedItem(batch, task.index, task.itemId);
      if (committed) return committed;
    }
    // 批量交付只有正式模式，没有 previewed。
    return item as ItemResult;
  };
}
