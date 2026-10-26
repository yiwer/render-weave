// 只在顶层 CLI 注入两个外部故障：系统终止立即失败、清理回执不能发布。
// IPC 宿主的断连回收保持真实行为，不等待 30 秒，也不改业务文件的写入。
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';
if (process.platform === 'win32' && typeof process.send !== 'function') {
  const spawn = childProcess.spawn, rename = fs.promises.rename;
  childProcess.spawn = (command, args, options) => command === 'taskkill'
    ? spawn(process.execPath, ['-e', 'process.exit(1)'], options)
    : spawn(command, args, options);
  fs.promises.rename = async (source, target) => {
    if (basename(String(target)) === 'cleanup.json') throw Object.assign(new Error(`ENOSPC: cleanup receipt unavailable ${process.env.RW_BUDGET_TEST_KEY ?? process.env.RW_ATTEMPTS_KEY}`), { code: 'ENOSPC' });
    return rename(source, target);
  };
  syncBuiltinESMExports();
}
