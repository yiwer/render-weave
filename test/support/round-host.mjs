/** 公开任务入口的独立宿主。仅在外部文件系统发布边界模拟挂起，供强退验收。 */
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
const options = JSON.parse(await fs.promises.readFile(process.argv[2], 'utf8'));
if (['block-final', 'block-initialized', 'delay-executing'].includes(process.argv[3])) {
  const rename = fs.promises.rename;
  fs.promises.rename = async (source, target) => {
    if (process.argv[3] === 'delay-executing' && target === join(options.out, 'execution.json')
      && JSON.parse(await fs.promises.readFile(source, 'utf8')).phase === 'executing') await new Promise(resolve => setTimeout(resolve, 500));
    const startup = process.argv[3] === 'block-initialized' && target === join(options.out, 'execution.json')
      && JSON.parse(await fs.promises.readFile(source, 'utf8')).startSha256;
    if (startup || (process.argv[3] === 'block-final' && target === join(options.out, 'round.json'))) {
      await fs.promises.writeFile(join(options.out, startup ? 'start-write-waiting' : 'final-write-waiting'), 'filesystem publish stalled');
      await new Promise(() => { setInterval(() => {}, 1000); });
    }
    return rename(source, target);
  };
  syncBuiltinESMExports();
}
const { runAgentTask } = await import('../../src/index.ts');
await runAgentTask(options);
