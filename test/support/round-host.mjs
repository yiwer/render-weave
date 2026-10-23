/** 实际 bin CLI 的独立宿主。仅在外部文件系统发布边界模拟挂起，供强退验收。 */
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
const options = JSON.parse(await fs.promises.readFile(process.argv[2], 'utf8'));
const fault = process.argv[3];
if (['block-final', 'block-initialized', 'delay-executing'].includes(fault)) {
  const rename = fs.promises.rename;
  fs.promises.rename = async (source, target) => {
    if (fault === 'delay-executing' && target === join(options.out, 'execution.json')
      && JSON.parse(await fs.promises.readFile(source, 'utf8')).phase === 'executing') await new Promise(resolve => setTimeout(resolve, 500));
    const startup = fault === 'block-initialized' && target === join(options.out, 'execution.json')
      && JSON.parse(await fs.promises.readFile(source, 'utf8')).startSha256;
    if (startup || (fault === 'block-final' && target === join(options.out, 'round.json'))) {
      await fs.promises.writeFile(join(options.out, startup ? 'start-write-waiting' : 'final-write-waiting'), 'filesystem publish stalled');
      await new Promise(() => { setInterval(() => {}, 1000); });
    }
    return rename(source, target);
  };
  syncBuiltinESMExports();
}
process.env[options.keyEnv] = options.key;
process.argv = [process.execPath, 'renderweave', 'agent', 'run', '--task', options.task, '--sample', options.sample,
  '--brief', options.brief, '--resources', options.resources, '--out', options.out, '--key-env', options.keyEnv,
  '--claude', options.claude.command, '--claude-args', JSON.stringify(options.claude.args)];
await import('../../src/bin.ts');
