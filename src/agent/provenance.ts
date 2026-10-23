/** 普通轮次与评估共用源码/资料清单；原文另由轮次宿主保存。 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../../', import.meta.url));
const execute = promisify(execFile);
export async function materialHashes(directory: string, prefix: string): Promise<Record<string, string>> {
  const files = (await readdir(directory, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile());
  const result: Record<string, string> = {};
  for (const file of files) {
    const absolute = join(file.parentPath, file.name);
    const key = `${prefix}/${absolute.slice(directory.length + 1).replaceAll('\\', '/')}`;
    result[key] = createHash('sha256').update(await readFile(absolute)).digest('hex');
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}
export async function agentProvenance() {
  const git = async (args: string[]) => (await execute('git', args, { cwd: root, windowsHide: true })).stdout.trim();
  let source: { commit: string; dirty: boolean };
  try { source = { commit: await git(['rev-parse', 'HEAD']), dirty: (await git(['status', '--porcelain'])).length > 0 }; }
  catch { source = { commit: 'unknown', dirty: true }; }
  return { git: source, materials: await materialHashes(join(root, 'agent'), 'agent') };
}
