/** 本次真实配对原件归档的公开脚本，夹具不代表模型观测。 */
import {execFile} from 'node:child_process';
import {mkdtemp,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {repoRoot} from './support/fixtures.js';
let root:string;
beforeAll(async()=>{root=await mkdtemp(join(tmpdir(),'rw-context-archive-'));});
afterAll(async()=>{await rm(root,{recursive:true,force:true});});
const run=(...args:string[])=>promisify(execFile)(process.execPath,['--import','tsx','scripts/agent-eval/archive-context-trial.ts',...args],{cwd:repoRoot,windowsHide:true});
it('全部成功与失败原件按原相对路径恢复，重复资源仅存一次，清单另有摘要',async()=>{
  const source=join(root,'originals'),archive=join(root,'archive'),restored=join(root,'restored'),config=join(root,'inputs.json');
  await mkdir(join(source,'failed','logs'),{recursive:true});await mkdir(join(source,'passed','resources'),{recursive:true});
  await writeFile(join(source,'failed','logs','stream.jsonl'),'failed\n');
  await writeFile(join(source,'failed','font.otf'),'same-font');
  await writeFile(join(source,'passed','resources','font.otf'),'same-font');
  await writeFile(config,JSON.stringify({format:'renderweave-context-trial-archive-inputs/1',roots:[{label:'trial',path:source}]}));
  await run('--pack',config,'--out',archive);
  expect((await readdir(join(archive,'blobs'))).length).toBe(2);
  expect(await readFile(join(archive,'manifest.sha256'),'utf8')).toMatch(/^[a-f0-9]{64}\n$/);
  const result=JSON.parse((await run('--restore',archive,'--out',restored)).stdout);
  expect(result).toMatchObject({filesVerified:3,sourceRoots:1});
  expect(await readFile(join(restored,'trial','failed','logs','stream.jsonl'),'utf8')).toBe('failed\n');
  expect(await readFile(join(restored,'trial','passed','resources','font.otf'),'utf8')).toBe('same-font');
  expect(await readFile(join(source,'failed','logs','stream.jsonl'),'utf8')).toBe('failed\n');
});
