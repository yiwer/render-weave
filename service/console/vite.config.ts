/**
 * 出图控制台的构建（票据 12，M279）：React 加 Vite，产物写到 service/dist/console，由接口进程在 /console/ 下提供。
 * 本机开发：先起出图服务（node service/scripts/up.mjs），再在 service/ 下 npx vite console，开放 API 的请求转给 8080。
 */
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/console/',
  plugins: [react()],
  build: { outDir: '../dist/console', emptyOutDir: true, sourcemap: false },
  server: { proxy: { '/v1': 'http://127.0.0.1:8080' } },
});
