// 整个外部 CanvasKit 后端阻塞；验证宿主不能依赖同一线程的定时回调。
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const readFileSync = fs.readFileSync;
fs.readFileSync = (path, ...args) => {
  if (String(path).endsWith('canvaskit.wasm')) {
    fs.writeFileSync(process.env.RW_BUDGET_FAULT_MARKER, String(process.pid));
    while (true) { /* 模拟同步渲染没有把执行权交回事件循环。 */ }
  }
  return readFileSync(path, ...args);
};
syncBuiltinESMExports();
