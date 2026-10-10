// 准备脚本：下载 scripts/fonts.json 列出的固定版本字体，并核对 SHA-256。
// 已存在且校验通过的文件直接跳过，因此可以在每次测试前运行。
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(await readFile(join(root, 'scripts', 'fonts.json'), 'utf8'));
const targetDir = join(root, lock.targetDir);
await mkdir(targetDir, { recursive: true });

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function readIfExists(file) {
  try {
    return await readFile(file);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

let failed = false;
for (const font of lock.fonts) {
  const target = join(targetDir, font.file);
  const existing = await readIfExists(target);
  if (existing && sha256(existing) === font.sha256) continue;

  const url = `${lock.source}/raw/${lock.release}/${lock.path}/${font.file}`;
  process.stdout.write(`下载 ${font.file} …\n`);
  let bytes;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    process.stderr.write(
      `下载失败：${url}\n  ${error.message}\n` +
        `  需要代理时可设置 NODE_USE_ENV_PROXY=1 与 HTTPS_PROXY；也可手动下载到 ${target}\n`,
    );
    failed = true;
    continue;
  }
  const actual = sha256(bytes);
  if (actual !== font.sha256) {
    process.stderr.write(`校验失败：${font.file}\n  期望 ${font.sha256}\n  实际 ${actual}\n`);
    failed = true;
    continue;
  }
  await writeFile(`${target}.part`, bytes);
  await rename(`${target}.part`, target);
}

if (failed) process.exit(1);
