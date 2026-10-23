/** 整个外部文件发布边界，预加载到 CLI 与其执行宿主。 */
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
const fault = process.env.RW_EXECUTION_FAULT, out = process.env.RW_EXECUTION_OUT;
if (fault && out) {
  const rename = fs.promises.rename;
  fs.promises.rename = async (source, target) => {
    if (fault === 'delay-executing' && target === join(out, 'execution.json') && JSON.parse(await fs.promises.readFile(source, 'utf8')).phase === 'executing')
      await new Promise(resolve => setTimeout(resolve, 500));
    const startup = fault === 'block-initialized' && target === join(out, 'execution.json') && JSON.parse(await fs.promises.readFile(source, 'utf8')).startSha256;
    if (startup || (fault === 'block-final' && target === join(out, 'round.json'))) {
      await fs.promises.writeFile(join(out, startup ? 'start-write-waiting' : 'final-write-waiting'), 'filesystem publish stalled');
      await new Promise(() => { setInterval(() => {}, 1000); });
    }
    return rename(source, target);
  };
  syncBuiltinESMExports();
}
