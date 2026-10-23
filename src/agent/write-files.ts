/** 审核记录的整份替换；多文件应用由 local-commit 持久意图负责。 */
import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isRecord } from '../util.js';

export interface JsonFileWrite {
  readonly path: string;
  readonly value: unknown;
  /** create：排他创建，文件已存在时失败；replace：整份替换已有的文件。 */
  readonly mode: 'create' | 'replace';
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
