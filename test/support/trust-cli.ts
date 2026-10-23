import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { repoRoot } from './fixtures.js';
export function trustCli(args: readonly string[], env: Record<string, string> = {}) {
  return new Promise<{ code: number | null; output: string }>(resolve => {
    const child = spawn(process.execPath, [join(repoRoot, 'dist/bin.js'), ...args], { cwd: repoRoot, windowsHide: true, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', b => { output += String(b); }); child.stderr.on('data', b => { output += String(b); });
    child.on('error', error => { output += error.message; }); child.on('close', code => resolve({ code, output }));
  });
}
export function toolResults(requests: any[]) {
  const results = requests.flatMap(r => r.messages).filter(m => Array.isArray(m.content)).flatMap(m => m.content).filter(b => b.type === 'tool_result');
  return [...new Map(results.map(r => [r.tool_use_id, r])).values()];
}