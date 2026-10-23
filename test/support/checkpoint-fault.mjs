/** 独立 CLI 宿主的文件系统故障边界；不替换产品检查器或 MCP 协议。 */
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
const fault = process.env.RW_CHECKPOINT_FAULT, out = process.env.RW_CHECKPOINT_FAULT_OUT;
const rename = fs.promises.rename, readFile = fs.promises.readFile, writeFile = fs.promises.writeFile;
let publications = 0, mutated = false, candidateReads = 0;
fs.promises.rename = async (source, target) => {
  if (fault === 'final-error' && target === join(out, 'round.json')) throw new Error('controlled final commit failure');
  if (target === join(out, 'checkpoint.json')) {
    publications++;
    if (fault === 'final-edit' && publications === 2) await writeFile(join(out, 'agent/candidates/schema.json'), '{"unexamined":true}');
  }
  if ((fault === 'publish-second' && target === join(out, 'checkpoint.json') && publications === 2)
    || (fault === 'final' && target === join(out, 'round.json'))) {
    await writeFile(join(out, 'fault-ready.json'), JSON.stringify({ fault, publications }));
    await new Promise(() => { setInterval(() => {}, 1000); });
  }
  return rename(source, target);
};
fs.promises.writeFile = async (path, ...args) => {
  if (fault === 'prepare-error' && path === join(out, 'logs/prompt.md')) throw new Error('controlled preparation failure');
  return writeFile(path, ...args);
};
fs.promises.readFile = async (path, ...args) => {
  const bytes = await readFile(path, ...args);
  if (String(path).endsWith(join('agent/candidates/schema.json')) && !String(path).includes(`${join('checkpoints')}\\`)) {
    candidateReads++;
    if (!mutated && ((fault === 'reading' && candidateReads === 1) || (fault === 'reading-final' && candidateReads === 3))) {
      mutated = true;
      await writeFile(path, JSON.stringify({...JSON.parse(Buffer.from(bytes).toString('utf8')),name:'读取期间的新定义'}));
    }
  }
  return bytes;
};
syncBuiltinESMExports();
