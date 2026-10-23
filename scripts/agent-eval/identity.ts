/** 评估身份与重新评分所使用的内容摘要；不以文件路径或 git 提交代替实际内容。 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { materialHashes } from '../../src/agent/provenance.js';
import { DEFAULT_ENDPOINT, DEFAULT_GOOGLE_ENDPOINT, DEFAULT_MODEL, DEFAULT_SMALL_MODEL } from '../../src/agent/run.js';
import { AGENT_TASKS } from '../../src/agent/tasks.js';
import { MCP_CONTRACT_VERSION } from '../../src/mcp/tools.js';
import { REPO, repoPath, type EvalConfig, type Scenario } from './scenarios.js';
import type { RuntimeOptions } from './eval.js';

export const sha256 = (bytes: string | Uint8Array): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

export async function scorerIdentity(): Promise<string> {
  const files = ['scripts/agent-eval/score.ts', 'scripts/agent-eval/eval.ts', 'scripts/agent-eval/scenarios.ts'];
  return sha256(JSON.stringify(await Promise.all(files.map(async path => [path, sha256(await readFile(join(REPO, path)))]))));
}

export interface ExperimentIdentity {
  readonly format: 'renderweave-eval-identity/1';
  readonly runtime: { readonly model: string; readonly smallModel: string; readonly endpoint: string; readonly effort: string | null; readonly providerRevision: null };
  readonly executor: { readonly command: string; readonly args: readonly string[]; readonly version: string; readonly files: Readonly<Record<string, string>>; readonly node: string };
  readonly budgets: { readonly maxTurns: Readonly<Record<string, number>>; readonly roundTimeoutMs: null; readonly stagnation: null };
  readonly build: Readonly<Record<string, string>>;
  readonly mcpContract: string;
  readonly materials: Readonly<Record<string, string>>;
  readonly inputs: Readonly<Record<string, string>>;
  readonly resources: Readonly<Record<string, string>>;
  readonly config: string;
  readonly scorer: string;
  readonly plan: { readonly scenarios: readonly string[]; readonly repeat: number; readonly pairedJobs: number | null };
}

/** 使用实际文件摘要，不以路径或 git HEAD 代表构建、资料与输入。 */
export async function experimentIdentity(config: EvalConfig, configFile: string, scenarios: readonly Scenario[], runtime: RuntimeOptions,
  plan: ExperimentIdentity['plan']): Promise<ExperimentIdentity> {
  const model = runtime.model ?? DEFAULT_MODEL;
  const google = model.startsWith('gemini');
  const endpoint = new URL(runtime.endpoint ?? (google ? DEFAULT_GOOGLE_ENDPOINT : DEFAULT_ENDPOINT));
  if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('实验端点必须是没有凭据、查询或片段的 HTTP(S) 地址');
  }
  const command = await executable(runtime.claude?.command ?? 'claude');
  const args = runtime.claude?.args ?? [];
  const probe = await promisify(execFile)(command, [...args, '--version'], {cwd: REPO, windowsHide: true, timeout: 10000, maxBuffer: 16384});
  const version = probe.stdout.trim();
  if (!version) throw new Error('无法取得执行器版本，未派发评估');
  const executorFiles: Record<string, string> = {command: sha256(await readFile(command))};
  for (const [index, arg] of args.entries()) {
    try { if ((await stat(arg)).isFile()) executorFiles[`arg-${index}`] = sha256(await readFile(arg)); } catch { /* 普通命令参数 */ }
  }
  const inputs: Record<string, string> = {};
  const add = async (key: string, path: string) => { inputs[key] = sha256(await readFile(repoPath(path))); };
  for (const scenario of scenarios) {
    await add(`${scenario.id}/sample`, scenario.sample);
    await add(`${scenario.id}/brief`, scenario.brief);
    if (scenario.kind === 'transcription') {
      await add(`${scenario.id}/datasetBrief`, scenario.datasetBrief);
      await add(`${scenario.id}/truth`, scenario.truth);
    }
    if (scenario.kind === 'template' || scenario.kind === 'revision') {
      await add(`${scenario.id}/request`, scenario.request);
      for (const file of scenario.workspace.files) await add(`${scenario.id}/workspace/${file}`, join(scenario.workspace.from, file));
    }
    if (scenario.kind === 'revision') {
      await add(`${scenario.id}/requirement`, scenario.requirement);
      for (const file of scenario.savedTemplates.files) await add(`${scenario.id}/savedTemplates/${file}`, join(scenario.savedTemplates.from, file));
    }
  }
  return {
    format: 'renderweave-eval-identity/1',
    runtime: {model, smallModel: runtime.smallModel ?? (google ? model : DEFAULT_SMALL_MODEL), endpoint: endpoint.href.replace(/\/$/, ''), effort: runtime.effort ?? null, providerRevision: null},
    executor: {command, args, version, files: executorFiles, node: process.version},
    budgets: {maxTurns: Object.fromEntries(Object.values(AGENT_TASKS).map(task => [task.id, runtime.maxTurns ?? task.maxTurns])), roundTimeoutMs: null, stagnation: null},
    build: {...await materialHashes(join(REPO, 'dist'), 'dist'), 'package-lock.json': sha256(await readFile(join(REPO, 'package-lock.json')))},
    mcpContract: MCP_CONTRACT_VERSION, materials: await materialHashes(join(REPO, 'agent'), 'agent'), inputs,
    resources: await materialHashes(repoPath(config.resources), 'resources'), config: sha256(await readFile(configFile)), scorer: await scorerIdentity(), plan,
  };
}

export function identityDifferences(left: unknown, right: unknown, path = ''): string[] {
  if (JSON.stringify(left) === JSON.stringify(right)) return [];
  if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object' && !Array.isArray(left) && !Array.isArray(right)) {
    const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap(key => identityDifferences(a[key], b[key], path ? `${path}.${key}` : key));
  }
  return [path];
}

async function executable(command: string): Promise<string> {
  const directories = isAbsolute(command) || command.includes('/') || command.includes('\\') ? [''] : (process.env.PATH ?? process.env.Path ?? '').split(delimiter);
  const extensions = process.platform === 'win32' ? ['', '.exe', '.cmd'] : [''];
  for (const directory of directories) for (const extension of extensions) {
    const path = resolve(directory, command + extension);
    try { if ((await stat(path)).isFile()) return path; } catch { /* 下一个 PATH 项 */ }
  }
  throw new Error('无法定位执行器文件，请通过 --claude 指定可执行文件');
}
