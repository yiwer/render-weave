/**
 * 静态数据定义的落盘：`renderweave publish` 与 `renderweave agent apply` 共用。
 * 文件名由定义文件名与版本号决定；写入排他创建，绝不覆盖已有文件，可捕获的失败撤回本次创建的文件。
 */
import { open, rm, type FileHandle } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { withLocalAccess } from '../local-access.js';

/** 文件名沿用定义文件名：去掉 schema- 前缀与 -v<版本> 后缀，如 schema-route-sign-v1.json → schema-route-sign-v2.json 与 compiled-route-sign-v2.schema.json。 */
export function publishedFileNames(definitionFile: string, version: number): { readonly schema: string; readonly compiled: string } {
  const stem = basename(definitionFile, '.json').replace(/^schema-/, '').replace(/-v\d+$/, '');
  return { schema: `schema-${stem}-v${version}.json`, compiled: `compiled-${stem}-v${version}.schema.json` };
}

/** 逐个排他创建并写入 JSON；任一失败时撤回本次已创建的文件，再抛出原错误。 */
export async function writeExclusiveJsonFiles(files: readonly { path: string; value: unknown }[]): Promise<void> {
  return withLocalAccess(files.map(file => dirname(file.path)), () => writeLocked(files));
}
async function writeLocked(files: readonly { path: string; value: unknown }[]): Promise<void> {
  const owned: { path: string; handle: FileHandle }[] = [];
  try {
    for (const file of files) owned.push({ path: file.path, handle: await open(file.path, 'wx') });
    for (let i = 0; i < files.length; i++) await owned[i]!.handle.writeFile(`${JSON.stringify(files[i]!.value, null, 2)}\n`);
  } catch (error) {
    // Windows 必须先关闭句柄才能撤回；只清理排他创建成功的文件。
    for (const file of owned) await file.handle.close();
    for (const file of owned) await rm(file.path, { force: true });
    throw error;
  } finally {
    for (const file of owned) await file.handle.close();
  }
}
