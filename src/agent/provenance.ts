/** 普通轮次与评估共用源码/资料清单；原文另由轮次宿主保存。 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../../', import.meta.url));
const execute = promisify(execFile);
export async function materialHashes(directory: string, prefix: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const visit = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      // 拥有者/租约是瞬时协调状态，不是模型资料、资源或观测事实；进入目录前排除，避免消失竞态。
      if (entry.isDirectory()) { if (!/^\.write-(?:lock|released|abandoned)(?:-|$)/.test(entry.name)) await visit(absolute); }
      else if (entry.isFile()) {
        const key = `${prefix}/${relative(directory, absolute).replaceAll('\\', '/')}`;
        result[key] = createHash('sha256').update(await readFile(absolute)).digest('hex');
      }
    }
  };
  await visit(directory);
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}
export async function agentProvenance() {
  const git = async (args: string[]) => (await execute('git', args, { cwd: root, windowsHide: true })).stdout.trim();
  let source: { commit: string; dirty: boolean };
  try { source = { commit: await git(['rev-parse', 'HEAD']), dirty: (await git(['status', '--porcelain'])).length > 0 }; }
  catch { source = { commit: 'unknown', dirty: true }; }
  return { git: source, materials: await materialHashes(join(root, 'agent'), 'agent') };
}
