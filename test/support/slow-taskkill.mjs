// 整个操作系统进程树终止边界：负载高时 taskkill 迟迟不返回。只作用于没有 IPC 的顶层 CLI（监督器），
// 宿主与执行器照常结束自己的进程。RW_SLOW_TASKKILL_MS 为毫秒数时先等待再执行真实 taskkill，为 hang 时永不返回。
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const delay = process.env.RW_SLOW_TASKKILL_MS;
if (delay && process.platform === 'win32' && typeof process.send !== 'function') {
  const spawn = childProcess.spawn;
  const wrapper = 'const [ms, ...args] = process.argv.slice(1); if (ms === "hang") setInterval(() => {}, 1000); else setTimeout(() => {'
    + ' const done = require("node:child_process").spawnSync("taskkill", args, { windowsHide: true, stdio: "ignore" }); process.exit(done.status ?? 1); }, Number(ms));';
  childProcess.spawn = (command, args, options) => command === 'taskkill'
    ? spawn(process.execPath, ['-e', wrapper, delay, ...args], options)
    : spawn(command, args, options);
  syncBuiltinESMExports();
}
