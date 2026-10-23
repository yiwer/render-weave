// 整个公开应用调用之前/之后暂停；控制宿主生命周期，不注入逐文件步骤。
import { applyAgentRound } from '../../src/index.ts';
const [, , roundDir, boundary] = process.argv;
if (boundary === 'before') process.stdout.write('ready\n');
const result = await applyAgentRound({ roundDir });
if (boundary === 'after') process.stdout.write(result.applied ? 'committed\n' : JSON.stringify(result));
setInterval(() => {}, 1000);
