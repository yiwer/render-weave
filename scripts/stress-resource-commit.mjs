/**
 * 资源仓库清单提交压测（M200）：多路并发"初始化 + 首次导入"，要求全部成功。
 * 初始化曾以 link 发布清单，Windows 上约 2% 的新仓库此后无法被 rename 替换清单，首次导入持续 EPERM；
 * 该偶发依赖并发与时序，单元测试中复现率过低，故以本脚本作回归门槛。默认 8 路 × 120 轮，约 5 秒。
 * 用法：node scripts/stress-resource-commit.mjs [并发数] [每路轮数]
 */
process.env.UV_THREADPOOL_SIZE ??= '16';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { initializeResourceStore, importResources } = await import('../dist/index.js');
const workers = Number(process.argv[2] ?? 8), rounds = Number(process.argv[3] ?? 120);
const root = await mkdtemp(join(tmpdir(), 'renderweave-commit-stress-')), source = join(root, 'source');
await mkdir(join(source, 'images'), { recursive: true });
await copyFile('fixtures/resources/images/m402/route-no-m402.png', join(source, 'images', 'route.png'));
await writeFile(join(source, 'resources.json'), JSON.stringify({ resources: [{ id: 'route', kind: 'image', file: 'images/route.png' }] }));
const failures = [], started = performance.now();
try {
  await Promise.all(Array.from({ length: workers }, async (_, worker) => {
    for (let round = 0; round < rounds; round++) {
      const dir = join(root, `store-${worker}-${round}`);
      const problems = [...(await initializeResourceStore(dir)).problems, ...(await importResources({ sourceDir: source, dir })).problems];
      if (problems.length) failures.push(problems[0].message);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }));
} finally { await rm(root, { recursive: true, force: true }).catch(() => undefined); }
const seconds = Math.round((performance.now() - started) / 100) / 10;
assert.deepEqual(failures, [], `${failures.length}/${workers * rounds} 次失败，${seconds} 秒`);
console.log(`PASS: ${workers * rounds} 次初始化加首次导入全部成功，${seconds} 秒（${process.platform}）`);
