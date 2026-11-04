/** 服务端装配私有轮次文件。浏览器只得到任务 ID，不能指定宿主路径。 */
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import type { TenantStorage } from './backend.js';
import type { AgentArtifact, AgentJob } from './agent-jobs.js';

export const contentHash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export async function agentScratch<T>(work: (root: string) => Promise<T>): Promise<T> {
  const parent = resolve(tmpdir()), root = await mkdtemp(join(parent, 'rw-dataset-job-'));
  try { return await work(root); }
  finally {
    if (dirname(root) !== parent || !root.startsWith(join(parent, 'rw-dataset-job-'))) throw new Error('任务临时目录边界不符');
    await rm(root, { recursive: true, force: true });
  }
}
export async function artifactBytes(storage: TenantStorage, artifact: AgentArtifact): Promise<Uint8Array> {
  const bytes = await storage.contents.get(artifact.sha256);
  if (!bytes || bytes.length !== artifact.byteLength || contentHash(bytes) !== artifact.sha256) throw new Error('任务材料缺失或内容身份不符');
  return bytes;
}
export async function restoreAgentFiles(storage: TenantStorage, job: AgentJob, root: string): Promise<void> {
  if (!job.artifacts?.length) throw new Error('任务尚未交回完整成果');
  for (const artifact of job.artifacts) {
    const path = resolve(root, artifact.file);
    if (!path.startsWith(resolve(root) + sep) || !/^[a-zA-Z0-9_./-]+$/.test(artifact.file)) throw new Error('任务材料路径非法');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, await artifactBytes(storage, artifact), { flag: 'wx' });
  }
}
export async function captureAgentFiles(storage: TenantStorage, root: string): Promise<AgentArtifact[]> {
  const files: AgentArtifact[] = []; let total = 0;
  const visit = async (dir: string, prefix: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('任务成果不能包含链接');
      const file = prefix + entry.name, path = join(dir, entry.name);
      if (entry.isDirectory()) { await visit(path, file + '/'); continue; }
      if (!entry.isFile()) throw new Error('任务成果包含非法文件');
      const bytes = await readFile(path); total += bytes.length;
      if (total > 100 * 1024 * 1024 || files.length >= 2000) throw new Error('任务成果超出保存上限');
      files.push({ file, sha256: await storage.contents.put(bytes), byteLength: bytes.length });
    }
  };
  await visit(root, ''); return files;
}
