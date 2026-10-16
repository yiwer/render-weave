/**
 * 应用时的落盘（M49 的"应用即保存"）：新文件排他创建，模板的工作副本整份替换已保存的文件。
 * 先占住全部新文件，再逐个替换，最后写入新文件；任一失败都撤回本次写入：删去新建的文件，替换过的文件恢复原内容。
 */
import { randomUUID } from 'node:crypto';
import { open, readFile, rename, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isRecord } from '../util.js';

export interface JsonFileWrite {
  readonly path: string;
  readonly value: unknown;
  /** create：排他创建，文件已存在时失败；replace：整份替换已有的文件。 */
  readonly mode: 'create' | 'replace';
}

/** 全部写入成功时返回撤回函数：之后的步骤失败时用它恢复原状。 */
export async function writeJsonFiles(files: readonly JsonFileWrite[]): Promise<() => Promise<void>> {
  const created: { path: string; handle: FileHandle; value: unknown }[] = [];
  const replaced: { path: string; original: Buffer }[] = [];
  try {
    for (const file of files.filter((item) => item.mode === 'create')) created.push({ path: file.path, handle: await open(file.path, 'wx'), value: file.value });
    for (const file of files.filter((item) => item.mode === 'replace')) {
      const original = await readFile(file.path);
      await replaceFile(file.path, json(file.value));
      replaced.push({ path: file.path, original });
    }
    for (const file of created) await file.handle.writeFile(json(file.value));
  } catch (error) {
    // Windows 必须先关闭句柄才能删除；只清理排他创建成功的文件。
    await Promise.all(created.map((file) => file.handle.close()));
    await undo(created, replaced);
    throw error;
  }
  await Promise.all(created.map((file) => file.handle.close()));
  return () => undo(created, replaced);
}

async function undo(created: readonly { path: string }[], replaced: readonly { path: string; original: Buffer }[]): Promise<void> {
  for (const file of created) await rm(file.path, { force: true });
  for (const file of [...replaced].reverse()) await replaceFile(file.path, file.original);
}

/** 先写临时文件再改名，读者总能读到一份完整的内容。Windows 上替换偶尔短暂被拒，有界重试。 */
export async function replaceFile(path: string, content: string | Uint8Array): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  await writeFile(temporary, content, { flag: 'wx' });
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(temporary, path);
        return;
      } catch (error) {
        if (process.platform !== 'win32' || attempt >= 7 || !isRecord(error) || !['EPERM', 'EACCES', 'EBUSY'].includes(String(error['code']))) throw error;
        await delay(20 * 2 ** attempt);
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
