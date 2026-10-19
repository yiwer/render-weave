/**
 * Docker 后端测试（不进 npm test）：在 Compose 网络里的 tester 容器中运行，连真实的 PostgreSQL、S3 兼容存储、接口进程与 worker。
 * 服务经 src/engine.ts 引用引擎的 dist；这里把它换成引擎源码，与共用的合同用例使用同一份引擎。
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const repo = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: { alias: [{ find: /^\.\.\/\.\.\/dist\/index\.js$/, replacement: `${repo}src/index.ts` }] },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
