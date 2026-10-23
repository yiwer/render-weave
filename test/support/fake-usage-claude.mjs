// 受控执行器：按给定用量和结束原因交回成果，不调用模型。
import { cp, writeFile, access } from 'node:fs/promises';
if (process.argv.includes('--version')) { console.log('fake-usage-1'); process.exit(0); }
const parameters = process.argv.slice(2);
const [preset, usage, error, holdParameter] = parameters.slice(0, parameters.indexOf('-p') < 0 ? undefined : parameters.indexOf('-p'));
for await (const _ of process.stdin) { /* 消费提示词 */ }
if (preset !== 'none') await cp(preset, process.cwd(), {recursive: true});
const emit = value => console.log(JSON.stringify(value));
emit({type: 'system', subtype: 'init', model: process.env.ANTHROPIC_MODEL, claude_code_version: 'fake-usage-1'});
if (usage === 'unknown') process.kill(process.pid, 'SIGKILL');
if (usage !== 'unknown') emit({type: 'result', subtype: 'success', is_error: !!error, result: error ?? '', num_turns: 2,
  usage: JSON.parse(usage)});

const hold = holdParameter?.startsWith('hold:') ? holdParameter.slice(5) : undefined;
if (hold) {
  const exists = await access(hold).then(() => true, () => false);
  if (!exists) {await writeFile(hold, JSON.stringify({pid: process.pid, host: process.ppid})); await new Promise(() => {setInterval(() => {}, 1000);});}
}
