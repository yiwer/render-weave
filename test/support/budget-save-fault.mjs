// 停止后本地最终记录发布阻塞，监督器仍必须结束保存子进程。
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const rename = fs.promises.rename;
fs.promises.rename = async (source, target) => {
  if (String(target).endsWith('round.json')) {
    fs.writeFileSync(process.env.RW_BUDGET_FAULT_MARKER, String(process.pid));
    while (true) { /* 整个文件系统提交边界失去响应。 */ }
  }
  return rename(source, target);
};
syncBuiltinESMExports();
