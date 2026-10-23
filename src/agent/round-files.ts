/**
 * 发起、审核与应用共用的轮次文件工具：用法错误、工作区指纹与文件判断。
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { withLocalAccess } from '../local-access.js';

/** 参数、输入文件或任务顺序不对：命令行报用法错误，不创建轮次目录。 */
export class AgentUsageError extends Error {}

/** 工作区指纹：按文件名排序的 JSON 文件名与内容哈希，再整体取哈希；应用时据此判断工作区是否已变（M51）。 */
export async function workspaceFingerprint(dir: string): Promise<string> {
  return fingerprintHashes(await jsonFileHashes(dir));
}
export function fingerprintHashes(hashes: ReadonlyMap<string, string>): string {
  const hash = createHash('sha256');
  for (const [file, digest] of [...hashes].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) hash.update(`${file}\0${digest}\n`);
  return `sha256:${hash.digest('hex')}`;
}

/** 目录顶层 JSON 文件的内容哈希，按文件名排序。 */
export async function jsonFileHashes(dir: string): Promise<Map<string, string>> {
  return withLocalAccess([dir], () => jsonFileHashesLocked(dir), 1000);
}
async function jsonFileHashesLocked(dir: string): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  for (const file of (await readdir(dir)).filter((name) => name.endsWith('.json')).sort()) {
    hashes.set(file, sha256(await readFile(join(dir, file))));
  }
  return hashes;
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

export async function isFile(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

export async function isDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}
