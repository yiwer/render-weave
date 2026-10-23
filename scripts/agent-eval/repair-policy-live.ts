/** 产品接线验收：沿用两种已知坏例，显式核准受控参考；不作为任意 PNG 的自动标注。 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import type { DesignCheckPlan } from '../../src/index.js';
import { CROSS_CASES, prepareCrossExperiment, scoreCrossRound } from './cross-experiment.js';

const { values } = parseArgs({ options: { out: { type: 'string' }, 'prepare-only': { type: 'boolean' } } });
if (!values.out) throw new Error('需要 --out <不存在的目录>');
const root = resolve(values.out), repo = resolve(import.meta.dirname, '../..');
// 必须使用已构建入口：从 tsx 的 src/run.ts 发起会把 MCP bin 错指向不存在的 src/bin.js。
const engine: typeof import('../../src/index.js') = await import(pathToFileURL(join(repo, 'dist/index.js')).href);
const { runAgentRepair, parseDesignCheckPlan, verifyTemplateDesign, loadWorkspace } = engine;
const key = process.env['OPEN_CODE_API_KEY'];
if (!key && !values['prepare-only']) throw new Error('OPEN_CODE_API_KEY 为空');
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
const save = async (path: string, value: unknown) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
await mkdir(root);
const fixtures = join(root, 'fixtures'); await prepareCrossExperiment(fixtures);
const results: unknown[] = [];
let failed = false, incomplete = false;
await save(join(root, 'protocol.json'), { head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  model: 'claude-haiku-5-5', maxTurns: 20, maxRounds: 2, cases: ['price', 'badge'], repeats: 1,
  scope: '产品接线 smoke，每模板一次；完整四场景门槛另跑。相同跨模板坏例，已核准受控布局；不宣称真实 PNG 自动参考或效果显著性。' });
for (const spec of CROSS_CASES) {
  const base = join(fixtures, spec.id), good = await json(join(base, 'control-score/report.json'));
  const baseData = (await json(join(base, 'control', spec.id === 'price' ? 'dataset-cross-price.json' : 'dataset-badge-zhang.json'))).data;
  const groups = new Map<string, Set<string>>();
  for (const input of good.inputs) for (const element of input.reference.elements) {
    const region = spec.regions.find(region => element.role === spec.template + '/' + region || element.role.startsWith(spec.template + '/' + region + '/')) ?? element.role;
    const paths = groups.get(region) ?? new Set<string>(); paths.add(element.path); groups.set(region, paths);
  }
  // 回归输入来自原实验显式数据，不让模型自报绑定成功。
  const raw = {
    format: 'renderweave-design-checks/1', basis: '受控实验维护模板的核准布局；只用于产品接线验收', styles: [],
    reference: { sha256: createHash('sha256').update(await readFile(join(base, 'reference.png'))).digest('hex') },
    cases: good.inputs.slice(1).map((input: any) => {
      const data = spec.id === 'price'
        ? input.id === 'binding' ? { ...baseData, productName: '高山矿泉水', retailPrice: 12.8, memberPrice: 9.9, features: ['清爽', '天然'] }
          : Object.fromEntries(Object.entries({ ...baseData, onSale: false }).filter(([key]) => key !== 'memberPrice'))
        : input.id === 'binding' ? { ...baseData, fullName: '李晓明', organization: '城市设计研究所', sessions: baseData.sessions.map((s: any, i: number) => i ? s : { ...s, title: '设计与验证' }), tags: ['设计', '嘉宾'] }
          : { ...baseData, role: '嘉宾', vip: true };
      return { id: input.id, parameters: input.request.parameters, changes: Object.keys(baseData).flatMap(key =>
        !(key in data) ? [{ path: '/' + key, op: 'remove' }] : JSON.stringify(baseData[key]) !== JSON.stringify(data[key]) ? [{ path: '/' + key, op: 'set', value: data[key] }] : []) };
    }),
    repair: { approval: 'approved', regions: [...groups].map(([id, paths]) => ({ id, paths: [...paths] })),
      references: good.inputs.map((input: any) => ({ case: input.id === 'base' ? 'reference' : input.id, geometry: input.id === 'base', reference: input.reference })) },
  };
  const plan: DesignCheckPlan = parseDesignCheckPlan(raw);
  const checks = join(base, 'product-checks.json'); await save(checks, plan);
  const sample = await readFile(join(base, 'reference.png'));
  const preflight = [];
  for (const folder of ['control', 'workspace']) {
    const workspace = await loadWorkspace({ dir: join(base, folder), resourcesDir: join(repo, 'fixtures/resources') });
    const { report } = await verifyTemplateDesign({ workspace, candidates: [], request: await json(join(base, 'request.json')), plan, sample });
    if (!report.repair?.complete || report.repair.checks.length !== good.checks.length || (folder === 'control') !== report.repair.passed) throw new Error('产品核查 preflight 与登记清单不符 ' + spec.id + '/' + folder + JSON.stringify(report));
    preflight.push({ folder, fingerprint: report.fingerprint, checked: report.repair.checks.length, failed: report.repair.failed });
  }
  await save(join(base, 'product-preflight.json'), preflight);
  const context = join(base, 'transport-context.json');
  await save(context, { task: 'template-revision', request: await json(join(base, 'request.json')),
    revision: { templates: [spec.template] }, designChecks: { plan, sampleFile: join(base, 'reference.png') } });
  const tools = engine.AGENT_TASKS['template-revision'].mcpTools;
  await save(join(base, 'transport-preflight.json'), await probeMcp([
    join(repo, 'dist/bin.js'), 'mcp', '--workspace', join(base, 'workspace'), '--resources', join(repo, 'fixtures/resources'),
    '--root', join(base, 'workspace'), '--outcome-context', context, '--tools', tools.join(','),
  ], tools));
  if (values['prepare-only']) { process.stdout.write(JSON.stringify({ case: spec.id, preflight }) + '\n'); continue; }
  const requirement = join(base, 'product-requirement.md');
  await writeFile(requirement, 'StaticSchema、数据集与参考图都已提供。按图局部修复模板，保留绑定、参数适配及元素名称；先保存 outcome.json，用 check_outcome 获取当前测量反馈。\n');
  process.stdout.write(JSON.stringify({ event: 'start', case: spec.id, at: new Date().toISOString() }) + '\n');
  const result = await runAgentRepair({ task: 'template-revision', workspace: join(base, 'workspace'), resources: join(repo, 'fixtures/resources'),
    sample: join(base, 'reference.png'), brief: join(base, 'brief.md'), request: join(base, 'request.json'), checks, requirement,
    ...(spec.id === 'price' ? { domain: 'price-tag' } : {}), out: join(root, spec.id), key: key!, keyEnv: 'OPEN_CODE_API_KEY',
    model: 'claude-haiku-5-5', smallModel: 'claude-haiku-5-5', maxTurns: 20 }, 2);
  const score = await scoreCrossRound(fixtures, spec.id, result.roundDir);
  const item = { case: spec.id, repairRun: result.repairRun, score, context: result.record.run.context, usage: result.record.run.wallMs };
  results.push(item); await save(join(root, 'results.json'), results);
  process.stdout.write(JSON.stringify(item) + '\n');
  failed ||= result.repairRun.reason !== 'complete' || !score.allPassed;
  if (result.repairRun.reason === 'runtimeStopped' || result.record.run.error) { incomplete = true; break; }
}
if (!values['prepare-only']) process.exitCode = incomplete ? 3 : failed ? 1 : 0;

/** 不调用模型的真实 stdio 预检；编译入口、宿主计划解析、工具连接均先验证。 */
function probeMcp(args: string[], expected: readonly string[]): Promise<unknown> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const replies: Record<number, any> = {}; let buffer = '', errors = '';
    const timeout = setTimeout(() => { child.kill(); fail(new Error('MCP 连接预检超时')); }, 10000);
    child.once('error', error => { clearTimeout(timeout); fail(error); });
    child.stderr.on('data', data => { errors = (errors + data).slice(-2000); });
    child.stdout.on('data', data => {
      buffer += String(data);
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const reply = JSON.parse(line); replies[reply.id] = reply;
          if (reply.id === 1) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
          if (reply.id === 2) child.stdin.end();
        } catch { child.kill(); }
      }
    });
    child.once('close', code => {
      clearTimeout(timeout);
      const names = replies[2]?.result?.tools?.map((tool: any) => tool.name).sort();
      if (code !== 0 || JSON.stringify(names) !== JSON.stringify([...expected].sort())) fail(new Error('MCP 连接预检失败：' + errors));
      else done({ server: replies[1].result.serverInfo, tools: names });
    });
    child.stdin.on('error', () => {});
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'repair-preflight', version: '1' } } }) + '\n');
  });
}
