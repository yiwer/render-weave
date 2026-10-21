/**
 * 打包下载（票据 08）：整批图片与导出包是 zip。先写进临时文件，每个文件在写进去之前读出并核对；
 * 全部写完才开始回答，中途发现损坏就丢掉临时文件、抛出原来的错误，回答里还来得及给出问题清单。
 * 文件按需读取（yazl 写到哪一项才读哪一项），一大批图片不会同时留在内存里；超过 4 GiB 时自动用 ZIP64。
 */
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import yazl from 'yazl';

export interface ZipEntry {
  /** zip 里的路径，用 / 分隔。 */
  readonly name: string;
  read(): Promise<Uint8Array>;
}

/** 已经压缩过的图片不再压缩。 */
const STORED = /\.(png|jpe?g|webp)$/i;

/** 把条目依次写进一个临时 zip 文件，返回它的路径；调用方用完后删掉。 */
export async function writeZip(entries: readonly ZipEntry[], mtime: Date): Promise<string> {
  const path = join(tmpdir(), `renderweave-${randomUUID()}.zip`);
  const zip = new yazl.ZipFile();
  const out = createWriteStream(path);
  const failed = new Promise<never>((_resolve, reject) => {
    zip.on('error', reject);
    out.on('error', reject);
  });
  zip.outputStream.pipe(out);
  for (const entry of entries) {
    zip.addReadStreamLazy(entry.name, { mtime, compress: !STORED.test(entry.name) }, (done) => {
      entry.read().then((bytes) => done(null, Readable.from([Buffer.from(bytes)], { objectMode: false })), (error: Error) => done(error, undefined as never));
    });
  }
  zip.end();
  try {
    await Promise.race([finished(out), failed]);
  } catch (error) {
    out.destroy();
    await rm(path, { force: true });
    throw error;
  }
  return path;
}
