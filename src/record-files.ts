/** 独占目录内先写完整内容，最后原子发布清单；残留目录没有清单便不是完整记录。 */
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { ProblemCodes } from './problems.js';
import { isRecord } from './util.js';
import { recordFail } from './record-input.js';

export interface RecordFile { readonly file: string; readonly sha256: string; readonly byteLength: number }
export const jsonBytes = (value: unknown): Uint8Array => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
export const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export const fileInfo = (file: string, bytes: Uint8Array): RecordFile => ({ file, sha256: digest(bytes), byteLength: bytes.length });
export function validFile(value: unknown): value is RecordFile {
  return isRecord(value) && typeof value.file === 'string' && /^(input\.json|image\.(png|jpg)|problems\.json|layout\.json|font-\d{6}\.bin)$/.test(value.file) &&
    typeof value.sha256 === 'string' && /^[0-9a-f]{64}$/.test(value.sha256) && typeof value.byteLength === 'number' && Number.isSafeInteger(value.byteLength) && value.byteLength >= 0;
}
export async function readRecordFile(root: string, file: string): Promise<Uint8Array> {
  // 文件名是受控的单层名称，拒绝路径、驱动器、ADS 及符号链接/目录。
  if (file !== 'record.json' && !validFile({ file, sha256: '0'.repeat(64), byteLength: 0 })) recordFail('记录含非法文件路径');
  const path = join(root, file);
  if (!(await fs.lstat(path)).isFile()) recordFail(`记录文件必须是普通文件：${file}`);
  if (await fs.realpath(path) !== join(root, file)) recordFail(`记录文件越出目录：${file}`);
  return new Uint8Array(await fs.readFile(path));
}
export async function recordRoot(dir: string): Promise<string> {
  const path = resolve(dir);
  if (!(await fs.lstat(path)).isDirectory()) recordFail('记录目录不能是链接或文件');
  return fs.realpath(path);
}
async function durableWrite(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await fs.open(path, 'wx');
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
export async function publishRecordDirectory(dir: string, files: ReadonlyMap<string, Uint8Array>, manifestName: 'record.json' | 'replay.json', manifest: unknown): Promise<void> {
  try {
    const root = resolve(dir);
    await fs.mkdir(dirname(root), { recursive: true });
    await fs.mkdir(root); // EEXIST 即失败，包括两个进程争同一个目标。
    for (const [file, bytes] of files) await durableWrite(join(root, file), bytes);
    const temporary = join(root, '.complete.tmp');
    await durableWrite(temporary, jsonBytes(manifest));
    // link 是同卷的原子、不覆盖发布；强退前没有完成清单，强退后完整内容已写好。
    await fs.link(temporary, join(root, manifestName));
    await fs.unlink(temporary).catch(() => undefined);
  } catch (error) {
    recordFail(`输出未交付：${error instanceof Error ? error.message : String(error)}`, ProblemCodes.deliveryWriteFailed);
  }
}
