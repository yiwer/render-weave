// 整个假执行器：留下可观察的所属子进程及已知用量，然后等待模型。
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
for await (const _ of process.stdin) {}
const child = spawn(process.execPath, ['--input-type=module', '-e', 'import {writeFileSync} from "node:fs"; setInterval(()=>writeFileSync("descendant-heartbeat",String(Date.now())),20);'], { stdio: 'ignore', windowsHide: true });
await writeFile('budget-processes.json', JSON.stringify({ executor: process.pid, child: child.pid }));
if (process.argv[2] === 'crash-host') process.kill(process.ppid, 'SIGKILL');
console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'test-model', claude_code_version: 'budget-test-1' }));
if (['partial', 'sparse'].includes(process.argv[2])) {
  for (const message of [
    { id: 'one', usage: { input_tokens: 10, output_tokens: 2 } },
    { id: 'one', usage: { input_tokens: 10, output_tokens: 5 } },
    { id: 'two', usage: { input_tokens: 20, output_tokens: 7 } },
  ]) console.log(JSON.stringify({ type: 'assistant', message }));
  if (process.argv[2] === 'sparse') {
    console.log(JSON.stringify({ type: 'assistant', message: { id: 'one', usage: { input_tokens: 11 } } }));
    console.log(JSON.stringify({ type: 'result', subtype: 'error', usage: {} }));
  }
} else console.log(JSON.stringify({ type: 'result', subtype: 'success', num_turns: 1, usage: { input_tokens: 123, output_tokens: 45 } }));
setInterval(() => {}, 1000);
