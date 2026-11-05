/** 工作簿任务宿主：固定输入、受控工具、隔离转换和独立核查，产物只进入候选轮次。 */
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { toolRunnerExecutor } from './tool-runner-executor.js';
import type { RoundExecutor } from './executor.js';
import { checkDataset } from '../dataset-validation.js';
import { createMemoryResourceRepository } from '../resources.js';
import { readWorkspaceDocuments, localWorkspaceDocuments, parseSchemaVersion } from '../workspace.js';
import { claudeCodeExecutor, DEFAULT_ENDPOINT, DEFAULT_MODEL, DEFAULT_KEY_ENV, readUsage } from './run.js';
import { startAnthropicProxy } from './anthropic-proxy.js';
import { credentialRedactor } from './credential-redaction.js';
import { serveMcp, type McpTool } from '../mcp/server.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const HERE = join(REPO, 'agent/excel');
export interface ExcelExtractionOptions {
  workspace: string; definition: string; workbook: string; brief: string; out: string;
  python?: string; claude?: string; executor?: 'claude-code' | 'tool-runner'; model?: string; endpoint?: string;
  signal?: AbortSignal; onProgress?: (message: string) => void;
  /** 替代模型执行器的确定性接缝；不从 HTTP 请求接收。 */
  execute?: RoundExecutor;
}
export async function runExcelExtraction(options: ExcelExtractionOptions): Promise<{ passed: boolean; out: string }> {
const values = { ...options, python: options.python ?? (process.platform === 'win32' ? 'python' : 'python3'), 'timeout-ms': '600000' };
const model = options.model ?? DEFAULT_MODEL, endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
for (const key of ['workspace', 'definition', 'workbook', 'brief', 'out'] as const) if (!values[key]) throw new Error(`缺少 --${key}`);
const key = process.env[DEFAULT_KEY_ENV];
if (!key) throw new Error(`缺少 ${DEFAULT_KEY_ENV}`);
const match = /^(.+)@(.+)$/.exec(values.definition!);
const version = match && parseSchemaVersion(match[2]);
if (!match || version === undefined) throw new Error('--definition 必须指定准确的 name@version');
const workspace = await readWorkspaceDocuments(localWorkspaceDocuments(resolve(values.workspace!)));
if (workspace.problems.some(p => p.level === 'severe')) throw new Error(JSON.stringify(workspace.problems));
const selected = workspace.staticSchemas.find(s => s.ref.name === match[1] && s.ref.version === version);
if (!selected?.compiled) throw new Error('工作空间中没有选定的已发布 staticSchema');
const timeoutMs = Number(values['timeout-ms']);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 1200000) throw new Error('轮次预算须在 1 秒至 20 分钟内');
const out = resolve(values.out!);
await mkdir(dirname(out), { recursive: true });
await mkdir(out); // 新轮次不覆盖旧证据。
const logs = join(out, 'logs'), agent = join(out, 'agent'), inputs = join(out, 'inputs');
for (const dir of [logs, agent, inputs]) await mkdir(dir);
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const save = async (file: string, data: unknown) => writeFile(file, JSON.stringify(data, null, 2)+'\n', { flag: 'wx' });
const json = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
const systemNames = ['SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'Path', 'PATH', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData', 'CommonProgramFiles', 'USERNAME', 'USER', 'USERDOMAIN', 'COMPUTERNAME', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'LANG'];
const env = Object.fromEntries(systemNames.flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]!]]));
const controller = new AbortController();
const cancelFile = join(out, 'cancel.signal');
let stopped: unknown, usage: unknown, finished: any;
const stop = (reason: unknown) => { stopped ??= reason; void writeFile(cancelFile, 'cancel'); controller.abort(); };
const cancel = () => stop({ reason: 'cancelled' });
options.signal?.addEventListener('abort', cancel, { once: true });
if (options.signal?.aborted) cancel();
try {
const safe = credentialRedactor([key]);

async function python(args: string[], ms = 45000) {
  if (controller.signal.aborted) throw new Error('轮次已停止');
  await new Promise<void>((done, fail) => {
    const p = spawn(values.python!, ['-X', 'utf8', ...args], { cwd: REPO, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let size = 0, errors = '';
    const timer = setTimeout(() => { p.kill(); fail(new Error('宿主工具执行超时')); }, ms);
    p.stdout.on('data', b => { size += b.length; if (size > 1048576) p.kill(); });
    p.stderr.on('data', b => { if (errors.length < 10000) errors += b.toString('utf8'); });
    p.once('error', e => { clearTimeout(timer); fail(e); });
    p.once('close', code => { clearTimeout(timer); code === 0 || code === 2 ? done() : fail(new Error(safe.text(errors || `Python 退出 ${code}`))); });
  });
}

await copyFile(resolve(values.workbook!), join(inputs, 'source.xlsx'));
const workbookReader = join(REPO, 'agent/excel/workbook.py');
await python([workbookReader, 'read', '--input', join(inputs, 'source.xlsx'), '--out', join(inputs, 'view.json')]);
const view = await json(join(inputs, 'view.json'));
const target = { selected, staticSchemas: workspace.staticSchemas, datasetIds: workspace.datasets.map(d => d.id) };
await save(join(inputs, 'target.json'), target);
const brief = await readFile(resolve(values.brief!), 'utf8');
const contract = await readFile(join(HERE, 'CONTRACT.md'), 'utf8');
await writeFile(join(inputs, 'brief.md'), brief, { flag: 'wx' });
options.onProgress?.('已读取工作簿，正在确定字段映射');
const prompt = `你是工作空间的数据集提取 CodingAgent。按选定的 staticSchema 处理 Excel，不能修改数据定义。\n先 read_schema 和 inspect_workbook，再按需 read_region。编写 Python 脚本，经 submit_transform 执行；按返回问题修改再提交。不要手工硬编码全部候选值，必须用固定视图和计划遍历数据。所有范围和数据集都须处理，保持顺序、重复值、前导零；歧义留待审核。检查通过后 finish。\n目标：${values.definition}\n项目说明：\n${brief}\n工具与计划合同：\n${contract}`;
await writeFile(join(logs, 'prompt.md'), prompt, { flag: 'wx' });
const attempts: any[] = [];
const toolsLog = join(logs, 'tools.jsonl');
const empty = { type: 'object', properties: {}, additionalProperties: false };
const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
let sequence = 0;
const tools: McpTool[] = [
  { name: 'inspect_workbook', description: '查看固定工作簿的源身份、Sheet、范围、合并关系与读取问题，不返回全部单元格。', inputSchema: empty,
    async call() { return result({ source: view.source, viewHash: view.viewHash, sheets: view.sheets.map(({ cells, comments = [], ...rest }: any) => ({ ...rest, cellCount: cells.length, commentCount: comments.length, commentCells: comments.map((c: any) => c.cell) })), issues: view.issues }); } },
  { name: 'read_schema', description: '读取工作空间选定的已发布 staticSchema、编译产物与引用定义，字段与约束均以此为准。', inputSchema: empty,
    async call() { return result(target); } },
  { name: 'read_region', description: '按 Sheet id 和 Excel 坐标读有界区域，保留空格、原值、显示值、公式和格式。',
    inputSchema: { type: 'object', properties: { sheet: { type: 'string' }, range: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, pageSize: { type: 'integer', minimum: 1, maximum: 100 } }, required: ['sheet', 'range'], additionalProperties: false },
    async call(a) { const file = join(logs, `region-${++sequence}.json`); await python([workbookReader, 'region', '--input', join(inputs, 'view.json'), '--sheet', String(a.sheet), '--range', String(a.range), '--offset', String(a.offset ?? 0), '--page-size', String(a.pageSize ?? 80), '--out', file]); return result(await json(file)); } },
  { name: 'submit_transform', description: '提交通用映射计划和 Python 转换脚本。在隔离环境执行，然后宿主独立核对来源并按固定 staticSchema 校验全部候选。失败应修复再提交。',
    inputSchema: { type: 'object', properties: { plan: { type: 'object' }, script: { type: 'string', minLength: 1, maxLength: 64000 } }, required: ['plan', 'script'], additionalProperties: false },
    async call(a) {
      if (finished) throw new Error('已经交回成果，不能继续修改');
      if (attempts.length >= 6) throw new Error('转换尝试达到 6 次上限');
      options.onProgress?.(`正在执行第 ${attempts.length + 1} 次转换与独立检查`);
      const plan = a.plan as any;
      if (JSON.stringify(plan).length > 200000 || plan.definition?.name !== selected.ref.name || plan.definition?.version !== selected.ref.version || plan.sourceHash !== view.source.sha256) throw new Error('计划过大或目标/原件身份不匹配');
      const id = `attempt-${String(attempts.length+1).padStart(2, '0')}`, dir = join(out, id);
      await mkdir(dir);
      const script = String(a.script);
      const record: any = { id, requestedScriptHash: hash(String(a.script)), executedScriptHash: hash(script), injected: false, status: 'running' };
      attempts.push(record);
      await save(join(dir, 'plan.json'), plan);
      await writeFile(join(dir, 'requested.py'), String(a.script), { flag: 'wx' });
      await writeFile(join(dir, 'transform.py'), script, { flag: 'wx' });
      try {
        await python([join(HERE, 'execute.py'), '--view', join(inputs, 'view.json'), '--plan', join(dir, 'plan.json'), '--script', join(dir, 'transform.py'), '--timeout', '10', '--cancel-file', cancelFile, '--out', join(dir, 'execution.json')]);
        const execution = await json(join(dir, 'execution.json'));
        record.execution = { status: execution.status, wallMs: execution.wallMs, cleanupConfirmed: execution.cleanupConfirmed, stderr: execution.stderr };
        if (execution.status === 'completed') {
          await save(join(dir, 'candidate.json'), execution.candidate);
          await python([join(REPO, 'agent/excel/generic_check.py'), '--view', join(inputs, 'view.json'), '--plan', join(dir, 'plan.json'), '--candidate', join(dir, 'candidate.json'), '--target', join(inputs, 'target.json'), '--out', join(dir, 'mechanical.json')]);
          record.mechanical = await json(join(dir, 'mechanical.json'));
          const bundle = execution.candidate;
          const items = Array.isArray(bundle?.datasets) ? bundle.datasets : [];
          const results = items.map((d: any) => ({ id: d.dataset?.id, problems: checkDataset(Buffer.from(JSON.stringify(d)), { staticSchemas: target.staticSchemas, resources: createMemoryResourceRepository([]) }).problems }));
          const identities = items.every((d: any) => d.dataset?.staticSchema?.name === selected.ref.name && d.dataset?.staticSchema?.version === selected.ref.version && !target.datasetIds.includes(d.dataset?.id));
          record.engine = { passed: items.length > 0 && identities && new Set(items.map((d: any) => d.dataset?.id)).size === items.length && results.every((r: any) => !r.problems.some((p: any) => p.level === 'severe')), identities, results };
          await save(join(dir, 'engine.json'), record.engine);
        }
        record.status = record.mechanical?.mechanical === 'passed' && record.engine?.passed === true && record.execution.cleanupConfirmed === true ? 'passed' : 'failed';
      } catch (error) { record.status = 'failed'; record.error = safe.text(String(error)); }
      await save(join(dir, 'feedback.json'), record);
      return result({ ...record, semantic: 'needsReview', applicable: false });
    } },
  { name: 'finish', description: '交回一次已通过机械与引擎检查的候选；说明待确认事项。不会应用、发布或出图。',
    inputSchema: { type: 'object', properties: { attemptId: { type: 'string' }, notes: { type: 'string', maxLength: 5000 }, pending: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 1000 } } }, required: ['attemptId', 'notes', 'pending'], additionalProperties: false },
    async call(a) { if (finished) throw new Error('已经交回'); const attempt = attempts.find(r => r.id === a.attemptId); if (attempt?.status !== 'passed') throw new Error('该尝试未通过全部检查'); finished = { ...a, semantic: 'needsReview', applicable: false }; await save(join(out, 'submission.json'), finished); return result(finished); } },
];

const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\rw-excel-${randomUUID()}` : join(tmpdir(), `rw-excel-${randomUUID()}.sock`);
const sockets = new Set<import('node:net').Socket>();
const sessions = new Set<Promise<void>>();
const bridge = createServer(socket => {
  if (sockets.size) { socket.destroy(); return; } // 一个轮次只有一个顺序工具会话。
  sockets.add(socket);
  const input = new PassThrough();
  const lines = createInterface({ input: socket, crlfDelay: Infinity });
  lines.on('line', line => { try { const frame = JSON.parse(line); if (frame.end) input.end(); else if (typeof frame.data === 'string' && frame.data.length < 1500000) input.write(Buffer.from(frame.data, 'base64')); else socket.destroy(); } catch { socket.destroy(); } });
  socket.on('close', () => { sockets.delete(socket); input.end(); });
  socket.on('error', () => input.end());
  const work = serveMcp(input, { tools, version: 'excel-extraction/1', write: line => { if (!socket.destroyed) socket.write(line); },
    log: async entry => { await appendFile(toolsLog, JSON.stringify(entry)+'\n'); } }).finally(() => { sessions.delete(work); socket.end(); });
  sessions.add(work);
});
await new Promise<void>((done, fail) => { bridge.once('error', fail); bridge.listen(pipe, done); });
let execution: unknown;
const started = Date.now();
let proxy: Awaited<ReturnType<typeof startAnthropicProxy>> | undefined;
try {
proxy = await startAnthropicProxy({ upstream: endpoint, key });
const command = values.claude ?? 'claude';
const executor = options.executor ?? 'tool-runner';
const version = executor === 'claude-code' ? execFileSync(command, ['--version'], { env, windowsHide: true, encoding: 'utf8' }).trim() : 'tool-runner';
const hostTools = Object.fromEntries(await Promise.all(['workbook.py', 'generic_check.py', 'execute.py', 'sandbox.py', 'CONTRACT.md'].map(async file => [file, hash(await readFile(join(HERE, file)))])));
await save(join(out, 'start.json'), { format: 'rw-excel-agent-prototype/2', startedAt: new Date().toISOString(), model, endpoint, executor, claudeCodeVersion: version, maxTurns: 24, timeoutMs, injection: false, sourceHash: view.source.sha256, targetHash: hash(await readFile(join(inputs, 'target.json'))), promptHash: hash(prompt), runtime: 'renderweave-excel-extraction/1', hostTools });
const timer = setTimeout(() => stop({ reason: 'timeout' }), timeoutMs);
try {
  execution = await (options.execute ?? (executor === 'claude-code' ? claudeCodeExecutor({ command }) : toolRunnerExecutor))({ cwd: agent, prompt, logsDir: logs, model, smallModel: model, maxTurns: 24,
    tools: '', mcp: { command: process.execPath, args: [join(REPO, 'dist/agent/mcp-forward.js'), pipe] }, proxy, env, secrets: [key, proxy.token], signal: controller.signal,
    stop, onSpawn: async pid => save(join(out, 'executor.json'), { pid }), onUsage: u => { usage = u; }, onEvent: e => { if (e.type === 'assistant') options.onProgress?.('正在核对数据与工具反馈'); } });
} catch (error) {
  stop({ reason: 'executor-error' });
  execution = { exitCode: 1, error: safe.text(String(error)) };
} finally {
  clearTimeout(timer);
}
} finally {
  // 宿主保有工具会话；先取消隔离脚本并等清理结束，再释放 MCP。
  await writeFile(cancelFile, 'finished');
  for (const socket of sockets) socket.destroy();
  await Promise.allSettled([...sessions]);
  await new Promise<void>(done => bridge.close(() => done()));
  await proxy?.close();
}
const observed = await readUsage(join(logs, 'stream.jsonl'));
const passed = !!finished && !stopped && (execution as any)?.exitCode === 0 && !observed.apiError;
const report = { format: 'rw-excel-agent-result/2', passed, realModelRun: options.execute === undefined, productionReady: false, wallMs: Date.now()-started, execution, stopped, usage: observed ?? usage, attempts, submission: finished ?? null, actualCharge: 'unknown; OpenCode Go 套餐，不以 Claude 显示标价推算扣费' };
await save(join(out, 'result.json'), report);
return { passed, out };
} finally { options.signal?.removeEventListener('abort', cancel); }
}
