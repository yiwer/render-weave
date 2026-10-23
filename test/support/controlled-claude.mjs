// 整个执行器边界的等待：宿主测试可在模型未交回期间执行公开产品操作。
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const [ready, release, preset, ...args] = process.argv.slice(2);
await writeFile(ready, 'waiting');
const deadline = Date.now() + 15000;
while (!await readFile(release).then(() => true, () => false)) {
  if (Date.now() > deadline) throw new Error('控制执行器等待超时');
  await delay(20);
}
process.argv = [process.argv[0], process.argv[1], preset, ...args];
await import('./fake-claude.mjs');
