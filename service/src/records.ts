/**
 * 出图记录（票据 08，ADR-0019）：重放一条记录，以及按登记的哈希核对后读出一项的文件。
 * 重放在 worker 里做（进程内渲染器与渲染子进程都调这一处），记录只由它所属的确切构建重放；
 * 下载与导出在接口进程里读，每个文件都按登记的 SHA-256 与字节数核对。
 */
import { createHash } from 'node:crypto';
import type { RegisteredFile, ReplayResult, ReplayTask, TenantStorage } from './backend.js';
import { ProblemCodes, replayRecord } from './engine.js';

/** 重放一条记录：引擎从记录本身构建工作区重新渲染，与记录比对；构建不是记录所属的那个时拒绝。 */
export async function replayItem(storage: TenantStorage, task: Pick<ReplayTask, 'batchId' | 'index'>): Promise<ReplayResult> {
  const result = await replayRecord(storage.openBatch(task.batchId).record(task.index));
  return { ...(result.replayed ? { manifest: result.replayed.manifest } : {}), problems: result.problems };
}

/** 读出的内容与登记的 SHA-256 或字节数不符：对象存储里的对象被改坏或换掉了。 */
export class IntegrityError extends Error {
  readonly code = ProblemCodes.recordIntegrityMismatch;
  constructor(readonly file: string, message: string) { super(message); }
}

/** 按登记读出一个文件并核对；不符时抛 IntegrityError。批次清单只登记了 SHA-256，不核对字节数。 */
export async function readRegistered(storage: TenantStorage, file: Pick<RegisteredFile, 'sha256'> & { readonly byteLength?: number }, where: string): Promise<Uint8Array> {
  const bytes = await storage.contents.get(file.sha256);
  if (!bytes) throw new IntegrityError(where, `${where} 的内容不在对象存储里`);
  if ((file.byteLength !== undefined && bytes.length !== file.byteLength) || createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
    throw new IntegrityError(where, `${where} 的内容与登记的 SHA-256 或字节数不符，对象可能已损坏`);
  }
  return bytes;
}
