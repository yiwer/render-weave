/** 跨模板受控修复：商品价签、会议胸牌；真实模型仍走同一 runAgentTask。 */
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadWorkspace, render, compareDesignImages, type Workspace, type RenderRequest } from '../../src/index.js';
import { createLayoutReference, checkLayoutReference, REFERENCE_THRESHOLDS } from './reference-checks.js';
import { boundedRepairFeedback, repairDelta, type RepairCheck } from './repair-feedback.js';
import { repairStopDecision } from './repair-policy.js';
import { fingerprints } from './repair-experiment.js';
type Doc = Record<string, any>;
const repo = resolve(import.meta.dirname, '../..'), resources = join(repo, 'fixtures/resources');
const json = async (p: string) => JSON.parse(await readFile(p, 'utf8'));
const save = async (p: string, value: unknown) => writeFile(p, JSON.stringify(value, null, 2) + '\n');
const sha = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
export const CROSS_CASES = [
  { id: 'price', label: '商品价签', source: 'fixtures/workspaces/price-tag', template: '商品价签', dataset: 'cross-price', domain: 'price-tag', width: 100, height: 52, dpi: 200,
    targets: ['商品价签/价格/零售价:position', '商品价签/页脚/货号:position'],
    regions: ['抬头', '价格', '页脚', '卖点行'] },
  { id: 'badge', label: '会议胸牌', source: 'fixtures/workspaces/console-badge', template: '会议胸牌', dataset: 'badge-zhang', width: 95, height: 135, dpi: 150,
    targets: ['会议胸牌/信息/证件号:position', '会议胸牌/标签行[1]/标签文字:position'],
    regions: ['页眉', '信息', '场次列', '标签行'] },
] as const;
type Spec = typeof CROSS_CASES[number];
const common = 'StaticSchema、数据集与参考图都已提供，不需从图提取业务数据。对照参考图修复当前模板的退化，保持其他部分、字段绑定和参数适配。仅局部修改主模板及已有子模板，保留元素名称以便定位；不要重画整页、以参考图作背景或写死示例值。先看参考与当前出图，修改后验证并交回有效 outcome.json 和 state.json。';
const next = '这是固定预算第二轮，也是最后一轮。再次对照同一参考与当前候选，按需局部修复，保持绑定和元素名称。无需改动时保留候选。验证后交回有效 outcome.json 和 state.json。';
const find = (n: Doc, name: string): Doc | undefined => n.name === name ? n : n.children?.map((c: Doc) => find(c, name)).find(Boolean);
export function crossDamage(document: Doc, id: string) {
  const d = structuredClone(document);
  if (id === 'price') { find(d.artboard, '价格')!.padding = { left: 5 }; find(d.artboard, '页脚')!.padding = { left: 2 }; }
  else if (id === 'badge') { find(d.artboard, '信息')!.padding = { left: 6 }; find(d.artboard, '标签行')!.place.margin = { left: 3 }; }
  else throw new Error('未知模板坏例');
  return d;
}
function variants(ws: Workspace, request: RenderRequest, spec: Spec) {
  return ['base', 'binding', 'state'].map(id => {
    const data = structuredClone(ws.datasets.find(d => d.id === spec.dataset)!.document) as Doc;
    const req = { ...structuredClone(request) };
    if (spec.id === 'price') {
      if (id === 'binding') { data.data.productName = '高山矿泉水'; data.data.retailPrice = 12.8; data.data.memberPrice = 9.9; data.data.features = ['清爽', '天然']; }
      if (id === 'state') { data.data.onSale = false; delete data.data.memberPrice; req.parameters = { storeName: '实验分店' }; }
    } else {
      if (id === 'binding') { data.data.fullName = '李晓明'; data.data.organization = '城市设计研究所'; data.data.sessions[0].title = '设计与验证'; data.data.tags = ['设计', '嘉宾']; }
      if (id === 'state') { data.data.role = '嘉宾'; data.data.vip = true; req.parameters = { showSeat: false, accentColor: '#1565C0', nameSize: 8, eventName: '城市设计论坛' }; }
    }
    return { id, request: req, data: data.data, workspace: { ...ws, datasets: ws.datasets.map(d => d.id === spec.dataset ? { ...d, document: data } : d) } as Workspace };
  });
}
async function measure(ws: Workspace, control: Workspace, request: RenderRequest, spec: Spec, dir: string) {
  await mkdir(dir, { recursive: true });
  const actuals = variants(ws, request, spec), refs = variants(control, request, spec), checks: RepairCheck[] = [], inputs = [];
  let pixel;
  for (const [i, v] of actuals.entries()) {
    const ref = refs[i]!;
    const good = await render(ref.workspace, ref.request), actual = await render(v.workspace, v.request);
    if (!good.image || !good.layout || good.problems.some(p => p.level === 'severe')) throw new Error('受控参考渲染失败 ' + spec.id + '/' + ref.id + JSON.stringify(good.problems));
    const reference = createLayoutReference(good.layout, '维护模板在固定数据/参数下的真实布局；受控实验参考，不是任意 PNG 的真值');
    const cs = checkLayoutReference(actual.layout, reference, i === 0).map(c => ({ ...c, id: `${v.id}/${c.id}` }));
    cs.push({ id: v.id + '/render:content', role: 'render', dimension: 'content', pass: !!actual.image && !actual.problems.some(p => p.level === 'severe'), severity: 100, detail: '必须生成图像且没有严重渲染问题' });
    checks.push(...cs); inputs.push({ id: v.id, dataSha256: sha(JSON.stringify(v.data)), request: v.request, problems: actual.problems, reference });
    if (actual.image) await writeFile(join(dir, v.id + '.png'), actual.image.bytes);
    if (i === 0 && actual.image) pixel = (await compareDesignImages({ reference: good.image.bytes, actual: actual.image.bytes, widthMm: spec.width, heightMm: spec.height })).report;
  }
  return { checks, inputs, pixel: pixel ?? null, templateSha256: sha(JSON.stringify(ws.templates.map(t => [t.name, t.document]))) };
}
function groupsFor(checks: RepairCheck[], spec: Spec): Record<string, string> {
  return Object.fromEntries(checks.map(c => [c.role, spec.regions.find(region => c.role.startsWith(spec.template + '/' + region + '/') || c.role === spec.template + '/' + region) ?? c.role]));
}
const baseChecks = (m: { checks: RepairCheck[] }) => m.checks.filter(c => c.id.startsWith('base/') && c.role !== 'render');
export async function prepareCrossExperiment(out: string) {
  await mkdir(out);
  for (const spec of CROSS_CASES) {
    const dir = join(out, spec.id), controlDir = join(dir, 'control'), workspaceDir = join(dir, 'workspace');
    await mkdir(controlDir, { recursive: true }); await mkdir(workspaceDir);
    for (const file of (await readdir(join(repo, spec.source))).filter(f => f.endsWith('.json'))) await copyFile(join(repo, spec.source, file), join(controlDir, file));
    if (spec.id === 'price') {
      const data = (await json(join(repo, 'fixtures/excel/price-tags.json'))).rows[0].data;
      await save(join(controlDir, 'dataset-cross-price.json'), { dataset: { id: spec.dataset, name: '跨模板价签对照', staticSchema: { name: '商品价签', version: 1 }, origin: { kind: 'manual' } }, data });
    } else {
      // 与 service/test/seed.ts 相同图片夹具，使用本地已有资源 ID，不修改共享资源仓库。
      const data = await json(join(controlDir, 'dataset-badge-zhang.json'));
      data.data.photo = 'res:test-quadrants-png';
      await save(join(controlDir, 'dataset-badge-zhang.json'), data);
    }
    const control = await loadWorkspace({ dir: controlDir, resourcesDir: resources });
    const request: RenderRequest = { template: spec.template, dataset: { id: spec.dataset }, parameters: {}, mode: 'final', output: { width: spec.width, height: spec.height, dpi: spec.dpi, format: 'png' } };
    const good = await measure(control, control, request, spec, join(dir, 'control-score'));
    if (good.checks.some(c => !c.pass)) throw new Error('正例存在失败 ' + spec.id + JSON.stringify(good.checks.filter(c => !c.pass)));
    await save(join(dir, 'control-score/report.json'), good);
    await copyFile(join(dir, 'control-score/base.png'), join(dir, 'reference.png'));
    for (const file of (await readdir(controlDir)).filter(f => f.endsWith('.json'))) {
      const d = await json(join(controlDir, file));
      await save(join(workspaceDir, file), d.dslVersion === 'renderweave-template/1' && d.name === spec.template ? crossDamage(d, spec.id) : d);
    }
    const ws = await loadWorkspace({ dir: workspaceDir, resourcesDir: resources });
    const initial = await measure(ws, control, request, spec, join(dir, 'initial'));
    if (spec.targets.some(id => initial.checks.find(c => c.id === 'base/' + id)?.pass !== false) || initial.inputs.some(v => v.problems.some(p => p.level === 'severe'))) throw new Error('坏例未形成预定退化或引入严重问题 ' + spec.id);
    await save(join(dir, 'initial/report.json'), initial); await save(join(dir, 'request.json'), request);
    await writeFile(join(dir, 'brief.md'), `这是${spec.label}的已保存模板局部修复任务，样例字段值已提供；同时保留数据/参数变化下的适配。\n`);
    await writeFile(join(dir, 'role.md'), common + '\n\n' + boundedRepairFeedback(baseChecks(initial)) + '\n');
    await writeFile(join(dir, 'region.md'), common + '\n\n' + boundedRepairFeedback(baseChecks(initial), groupsFor(initial.checks, spec)) + '\n');
  }
  const order = [];
  for (const repetition of [1, 2]) for (const [i, spec] of CROSS_CASES.entries()) for (const arm of (i + repetition) % 2 ? ['role', 'region'] : ['region', 'role']) order.push({ id: `${spec.id}-${repetition}-${arm}`, caseId: spec.id, repetition, arm });
  const files = ['cross-experiment.ts', 'reference-checks.ts', 'repair-experiment.ts', 'repair-feedback.ts', 'repair-policy.ts', 'repair-live.mjs', 'fidelity.ts'];
  const manifest = { format: 'renderweave-repair-experiment/2', comparison: 'cross-template', createdAt: new Date().toISOString(), head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    model: 'claude-haiku-5-5', rounds: 2, maxTurns: 20, thresholds: REFERENCE_THRESHOLDS, cases: CROSS_CASES, order,
    stopping: '完整登记检查通过且技术交回有效；首轮决定写入后固定执行影子续跑，共享前缀不视作独立停止臂',
    scripts: await Promise.all(files.map(async path => ({ path: 'scripts/agent-eval/' + path, sha256: sha(await readFile(join(repo, 'scripts/agent-eval', path))) }))),
    engine: await fingerprints(join(repo, 'src')), runtime: await fingerprints(join(repo, 'dist')), materials: await fingerprints(join(repo, 'agent')), resources: await fingerprints(resources), inputs: await fingerprints(out) };
  await save(join(out, 'manifest.json'), manifest);
  return { out, units: order.length, rounds: order.length * 2 };
}
export async function scoreCrossRound(root: string, caseId: string, round: string) {
  const spec = CROSS_CASES.find(c => c.id === caseId); if (!spec) throw new Error('未知模板');
  const dir = join(round, 'repair-score'); await mkdir(dir);
  const base = join(root, caseId), initial = await json(join(base, 'initial/report.json')), expected = await json(join(base, 'control-score/report.json'));
  const record = await json(join(round, 'round.json')), request = await json(join(base, 'request.json'));
  const control = await loadWorkspace({ dir: join(base, 'control'), resourcesDir: resources }), ws = await loadWorkspace({ dir: join(round, 'snapshot'), resourcesDir: resources });
  let outcome;
  try { outcome = await json(join(round, 'outcome.json')); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  let measurement = null;
  if (outcome) {
    const candidates = await Promise.all(outcome.candidates.filter((c: any) => c.kind === 'template').map(async (c: any) => {
      if (!/^candidates\/[^:]+\.json$/.test(c.path) || c.path.split(/[\\/]/).includes('..')) throw new Error('非法候选路径');
      const bytes = await readFile(join(round, c.path)); if (sha(bytes) !== c.sha256) throw new Error('候选指纹不一致');
      const document = JSON.parse(bytes.toString()); return { name: document.name, document };
    }));
    const names = new Set(candidates.map(c => c.name));
    measurement = await measure({ ...ws, templates: [...ws.templates.filter(t => !names.has(t.name)), ...candidates] }, control, request, spec, dir);
  }
  const result = { caseId, round, available: !!measurement, qualified: record.verdict === 'qualified',
    ...repairDelta(initial.checks, measurement?.checks ?? null, spec.targets.map(t => 'base/' + t), record.verdict === 'qualified'), measurement };
  await save(join(dir, 'report.json'), result);
  await save(join(dir, 'stop-decision.json'), { ...repairStopDecision(expected.checks.map((c: RepairCheck) => c.id), measurement?.checks ?? null, result.qualified),
    decidedAt: new Date().toISOString(), templateSha256: measurement?.templateSha256 ?? null, measurementSha256: sha(await readFile(join(dir, 'report.json'))) });
  for (const arm of ['role', 'region']) await writeFile(join(dir, arm + '-feedback.md'), next + '\n\n' + (measurement ? boundedRepairFeedback(baseChecks(measurement), arm === 'region' ? groupsFor(measurement.checks, spec) : {}) : '当前没有可用的交回布局证据，先保存有效成果。') + '\n');
  return { caseId, repaired: result.repaired, added: result.addedFailures, qualified: result.qualified, allPassed: measurement?.checks.every(c => c.pass) ?? false };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { prepare: { type: 'string' }, root: { type: 'string' }, case: { type: 'string' }, round: { type: 'string' } }, strict: true });
  if (values.prepare) console.log(JSON.stringify(await prepareCrossExperiment(resolve(values.prepare))));
  else if (values.root && values.case && values.round) console.log(JSON.stringify(await scoreCrossRound(resolve(values.root), values.case, resolve(values.round))));
  else throw new Error('需要 --prepare 新目录，或 --root --case --round');
}
