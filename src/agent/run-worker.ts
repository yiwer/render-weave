/** 私有宿主进程入口；只有监督器发送固定配置，不接受 Agent 工具请求。 */
import { runAgentTaskInHost } from './run.js';
import { saveStoppedRound } from './stopped-round.js';
import { AgentUsageError } from './round-files.js';
import { spawn } from 'node:child_process';

// 监督器强退时 IPC 断开：运行宿主仍是本轮子树的根，回收自己的后代。
process.once('disconnect', () => {
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(process.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else process.kill(-process.pid, 'SIGKILL');
});

const send = (value: unknown) => new Promise<void>((resolve, reject) => process.send!(value as any, error => error ? reject(error) : resolve()));
process.once('message', async (message: any) => {
  try {
    const value = message.mode === 'save' ? await saveStoppedRound(message) : await runAgentTaskInHost({ ...message.options,
      onStart: (roundDir: string) => { void send({ type: 'start', roundDir }); },
    }, {
      ready: async value => { const ack = new Promise<void>(resolve => process.once('message', () => resolve())); await send({ type: 'ready', value }); await ack; },
      stop: reason => { void send({ type: 'stop', reason }); },
      usage: value => { void send({ type: 'usage', value }); },
    });
    await send({ type: 'result', value });
  } catch (error) { await send({ type: 'error', message: error instanceof Error ? error.message : String(error), usage: error instanceof AgentUsageError }); }
  // 等监督器回收本轮全部子树，不让完成消息与拥有关系先后脱离。
});
