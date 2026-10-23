// 只负责提交预先定义的受控初始成果；不调用模型。
import {cp} from 'node:fs/promises';
if (process.argv.includes('--version')) {console.log('controlled-feedback-seed-1'); process.exit(0);}
for await (const _ of process.stdin) {}
await cp(process.argv[2], process.cwd(), {recursive: true});
console.log(JSON.stringify({type: 'result', subtype: 'success', is_error: false, num_turns: 0, usage: {input_tokens: 0, output_tokens: 0}}));
