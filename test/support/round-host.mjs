/** 实际 bin CLI 的独立宿主。仅在外部文件系统发布边界模拟挂起，供强退验收。 */
import fs from 'node:fs';
const options = JSON.parse(await fs.promises.readFile(process.argv[2], 'utf8'));
process.env.RW_EXECUTION_FAULT = process.argv[3];
process.env.RW_EXECUTION_OUT = options.out;
const preload = new URL('./execution-fault.mjs', import.meta.url);
process.execArgv.push('--import', preload.href);
await import(preload.href);
process.env[options.keyEnv] = options.key;
process.argv = [process.execPath, 'renderweave', 'agent', 'run', '--task', options.task, '--sample', options.sample,
  '--brief', options.brief, '--resources', options.resources, '--out', options.out, '--key-env', options.keyEnv,
  '--claude', options.claude.command, '--claude-args', JSON.stringify(options.claude.args)];
await import('../../src/bin.ts');

