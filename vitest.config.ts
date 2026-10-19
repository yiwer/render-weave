import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const engineSource = fileURLToPath(new URL('./src/index.ts', import.meta.url));

export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
    projects: [
      { test: { name: 'engine', include: ['test/**/*.test.ts'], testTimeout: 60_000, hookTimeout: 60_000 } },
      {
        // 出图服务的快速测试（内存后端）：服务经 dist 引用引擎，这里换成引擎源码，不需要先构建。
        // Docker 后端那组（*.docker.test.ts）由 node service/scripts/test-docker.mjs 运行。
        resolve: { alias: [{ find: /^\.\.\/\.\.\/dist\/index\.js$/, replacement: engineSource }] },
        test: { name: 'service', include: ['service/test/**/*.test.ts'], exclude: ['service/test/**/*.docker.test.ts'], testTimeout: 60_000, hookTimeout: 60_000 },
      },
    ],
  },
});
