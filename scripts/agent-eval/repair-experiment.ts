/** 准备、评分受控修复实验；模型执行在 repair-live.mjs，经现有产品路径进行。 */
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadWorkspace, render, compareDesignImages, type Workspace, type RenderRequest } from '../../src/index.js';
import { assessFidelity, m402DisplayContract, type M402Data } from './fidelity.js';
import { boundedRepairFeedback, repairChecks, repairDelta, REPAIR_THRESHOLDS, type RepairCheck } from './repair-feedback.js';
import { REPAIR_REGIONS, repairStopDecision } from './repair-policy.js';

const repo = resolve(import.meta.dirname, '../..');
const json = async (p: string) => JSON.parse(await readFile(p, 'utf8'));
const save = async (p: string, value: unknown) => writeFile(p, JSON.stringify(value, null, 2) + '\n');
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const resources = join(repo, 'fixtures/resources');
const source = join(repo, 'docs/examples/m402-dsl');
type Doc = Record<string, any>;
export const REPAIR_CASES = [
  { id: 'a', label: '标识与下一站地标', targets: ['badges:content', 'next-landmark:content'] },
  { id: 'b', label: '道路与运营方字号', targets: ['roads:font', 'operator:font'] },
  { id: 'c', label: '站点与下一站位置', targets: ['stations:position', 'next-stop:position'] },
] as const;
const request: RenderRequest = { template: '标准线路单边', dataset: { id: 'ds-m402-wanguocheng' }, parameters: { currentIndex: 5 }, output: { width: 740, height: 165, dpi: 50, format: 'png' }, mode: 'final' };
const common = '对照所给参考图，修复当前已保存模板的退化，使内容、文字层级和布局尽量恢复一致；保持其余部分与动态数据绑定。不要整页重画，不要用示例图作背景或写死示例值。修改范围为主模板及其已有被调模板。先看参考图和当前出图，局部修改后检查并交回有效 outcome.json 与 state.json。';
const next = '这是固定预算的第二轮，也是最后一轮。再次对照同一参考图和当前候选，检查内容、文字层级、位置及数据绑定；有差异就局部修复，无需改动时保持候选。验证后交回有效 outcome.json 与 state.json。';
const apply = (ws: Workspace, docs: Doc[]): Workspace => ({ ...ws, templates: docs.map((document) => ({ name: document.name, document })) });
function change(docs: Doc[], name: string, node: string, mutate: (n: Doc) => void) {
  const doc = docs.find((d) => d.name === name); let count = 0;
  const walk = (n: Doc) => { if (n.name === node) { count++; mutate(n); } n.children?.forEach(walk); };
  if (doc) walk(doc.artboard);
  if (count !== 1) throw new Error(`变体目标不唯一：${name}/${node}`);
}
export function damageTemplates(original: Doc[], id: string): Doc[] {
  const docs = structuredClone(original);
  if (id === 'a') {
    change(docs, '站点', '标识行', (n) => { n.visible = false; });
    change(docs, '标准线路单边', '下一站地标', (n) => { n.visible = false; });
  } else if (id === 'b') {
    change(docs, '道路段', '道路名', (n) => { n.fontSize = 4.5; });
    change(docs, '标准线路单边', '运营方', (n) => { n.fontSize = 5; });
  } else if (id === 'c') {
    change(docs, '标准线路单边', '站点面板', (n) => { n.padding.top = 10; });
    change(docs, '标准线路单边', '下一站区', (n) => { n.padding.left = 20; });
  } else throw new Error('未知坏例');
  return docs;
}
function inputVariants(ws: Workspace) {
  return ['base', 'rename', 'current-index'].map((id) => {
    const req = { ...structuredClone(request), parameters: { currentIndex: id === 'current-index' ? 10 : 5 } }, data = structuredClone(ws.datasets.find((d) => d.id === 'ds-m402-wanguocheng')!.document) as Doc;
    if (id === 'rename') data.data.stops[0].name = '实验改名总站';
    return { id, request: req, data: data.data as M402Data, workspace: { ...ws, datasets: ws.datasets.map((d) => d.id === 'ds-m402-wanguocheng' ? { ...d, document: data } : d) } as Workspace };
  });
}
async function measure(ws: Workspace, control: Workspace, dir: string) {
  await mkdir(dir, { recursive: true });
  const variants = inputVariants(ws), refs = inputVariants(control), checks: RepairCheck[] = [];
  const inputs = [];
  let baseMetrics, baseReference, pixel;
  for (let i = 0; i < variants.length; i++) {
    const v = variants[i]!, r = refs[i]!;
    const expected = await render(r.workspace, r.request), actual = await render(v.workspace, v.request);
    if (!expected.image || expected.problems.some((p) => p.level === 'severe')) throw new Error('受控参考渲染失败');
    const contract = m402DisplayContract(r.data, Number(r.request.parameters?.currentIndex));
    const ref = assessFidelity(expected.layout, contract), metric = assessFidelity(actual.layout, contract, ref);
    const cs = repairChecks(metric, ref, i === 0).map((c) => ({ ...c, id: v.id + '/' + c.id }));
    cs.push({ id: v.id + '/render:content', role: 'render', dimension: 'content', pass: !!actual.image && !actual.problems.some((p) => p.level === 'severe'), severity: 10, detail: '严重渲染问题或没有图像' });
    checks.push(...cs);
    inputs.push({ id: v.id, dataSha256: sha(JSON.stringify(v.data)), request: v.request, problems: actual.problems, metrics: metric });
    if (actual.image) await writeFile(join(dir, v.id + '.png'), actual.image.bytes);
    if (i === 0) {
      baseMetrics = metric; baseReference = ref;
      if (actual.image) pixel = (await compareDesignImages({ reference: expected.image.bytes, actual: actual.image.bytes, widthMm: 740, heightMm: 165 })).report;
    }
  }
  const baseChecks = repairChecks(baseMetrics!, baseReference!);
  return { checks, inputs, pixel: pixel ?? null, feedback: boundedRepairFeedback(baseChecks), templateSha256: sha(JSON.stringify(ws.templates.map((t) => [t.name, t.document]))) };
}
async function fingerprints(dir: string, prefix = ''): Promise<{ path: string; sha256: string }[]> {
  const result = [];
  for (const item of (await readdir(dir, { withFileTypes: true })).toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (item.isSymbolicLink()) throw new Error('指纹输入不能是链接');
    if (item.isDirectory()) result.push(...await fingerprints(join(dir, item.name), prefix + item.name + '/'));
    else if (item.isFile()) result.push({ path: prefix + item.name, sha256: sha(await readFile(join(dir, item.name))) });
  }
  return result;
}
export async function prepareRepairExperiment(out: string, comparison: 'image-evidence' | 'role-region' = 'image-evidence') {
  await mkdir(out); // 不覆盖之前的试验
  const ws = await loadWorkspace({ dir: source, resourcesDir: resources });
  const original = ws.templates.map((t) => t.document as Doc);
  await mkdir(join(out, 'control'));
  for (const file of (await readdir(source)).filter((f) => f.endsWith('.json'))) await copyFile(join(source, file), join(out, 'control', file));
  const reference = await render(ws, request);
  if (!reference.image) throw new Error('没有参考图');
  await writeFile(join(out, 'reference.png'), reference.image.bytes);
  await save(join(out, 'request.json'), request);
  await writeFile(join(out, 'brief.md'), '这是公交线路牌已保存模板的修复任务。数据定义与数据集已经提供，不需从图提取业务数据。所给图片是本次需恢复的视觉目标，数据变化时仍须自适应。\n');
  const good = await measure(ws, ws, join(out, 'control-score'));
  if (good.checks.some((c) => !c.pass)) throw new Error('正例未通过固定评分');
  await save(join(out, 'control-score/report.json'), good);
  const cases = comparison === 'role-region' ? REPAIR_CASES.filter(c => c.id === 'c') : REPAIR_CASES;
  for (const spec of cases) {
    const dir = join(out, spec.id), workspace = join(dir, 'workspace'); await mkdir(workspace, { recursive: true });
    const damaged = damageTemplates(original, spec.id);
    for (const file of (await readdir(source)).filter((f) => f.endsWith('.json'))) {
      const d = await json(join(source, file));
      await save(join(workspace, file), d.dslVersion === 'renderweave-template/1' ? damaged.find((t) => t.name === d.name) : d);
    }
    const score = await measure(apply(ws, damaged), ws, join(dir, 'initial'));
    if (spec.targets.some((id) => score.checks.find((c) => c.id === 'base/' + id)?.pass !== false)) throw new Error('坏例没有触发预期目标：' + spec.id);
    if (score.inputs.some((v) => v.problems.some((p) => p.level === 'severe'))) throw new Error('坏例引入严重问题');
    await save(join(dir, 'initial/report.json'), score);
    await writeFile(join(dir, 'image.md'), common + '\n');
    await writeFile(join(dir, 'evidence.md'), common + '\n\n' + score.feedback + '\n');
    if (comparison === 'role-region') {
      await writeFile(join(dir, 'role.md'), common + '\n\n' + score.feedback + '\n');
      await writeFile(join(dir, 'region.md'), common + '\n\n' + boundedRepairFeedback(score.checks.filter(c => c.id.startsWith('base/') && c.role !== 'render'), REPAIR_REGIONS) + '\n');
    }
  }
  const order = [];
  for (const repetition of [1, 2]) for (const [i, spec] of cases.entries()) {
    const pair = comparison === 'role-region' ? ['role', 'region'] : ['image', 'evidence'];
    const arms = (i + repetition) % 2 === 1 ? pair : pair.toReversed();
    for (const arm of arms) order.push({ id: `${spec.id}-${repetition}-${arm}`, caseId: spec.id, repetition, arm });
  }
  const files = ['repair-feedback.ts', 'repair-policy.ts', 'repair-experiment.ts', 'repair-live.mjs', 'fidelity.ts'];
  const manifest = { format: 'renderweave-repair-experiment/1', createdAt: new Date().toISOString(), head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    comparison, model: 'claude-haiku-5-5', rounds: 2, maxTurns: 20, thresholds: REPAIR_THRESHOLDS, cases, order,
    ...(comparison === 'role-region' ? { regions: REPAIR_REGIONS, stopping: '登记全检查停止决定，然后固定执行第二轮作影子对照；共享第一轮，不是独立停止臂。' } : {}),
    scripts: await Promise.all(files.map(async (f) => ({ path: 'scripts/agent-eval/' + f, sha256: sha(await readFile(join(repo, 'scripts/agent-eval', f))) }))),
    engine: await fingerprints(join(repo, 'src')), runtime: await fingerprints(join(repo, 'dist')), materials: await fingerprints(join(repo, 'agent')),
    resources: await fingerprints(resources), inputs: await fingerprints(out), referenceSha256: sha(reference.image.bytes) };
  await save(join(out, 'manifest.json'), manifest);
  return { units: order.length, rounds: order.length * 2, targets: cases.map((c) => c.targets), out };
}
export async function scoreRepairRound(root: string, caseId: string, round: string) {
  const dir = join(round, 'repair-score'), spec = REPAIR_CASES.find((c) => c.id === caseId);
  if (!spec) throw new Error('未知坏例');
  const manifest = await json(join(root, 'manifest.json'));
  // 决定时间必须早于影子续跑；拒绝重新评分覆盖事前证据。
  if (manifest.comparison === 'role-region') await mkdir(dir);
  const initial = await json(join(root, caseId, 'initial/report.json'));
  const record = await json(join(round, 'round.json'));
  const control = await loadWorkspace({ dir: join(root, 'control'), resourcesDir: resources });
  const base = await loadWorkspace({ dir: join(round, 'snapshot'), resourcesDir: resources });
  let outcome;
  try { outcome = await json(join(round, 'outcome.json')); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  let measurement = null;
  if (outcome) {
    const candidates = await Promise.all(outcome.candidates.filter((c: any) => c.kind === 'template').map(async (c: any) => {
      if (!/^candidates\/[^:]+\.json$/.test(c.path) || c.path.split(/[\\/]/).includes('..')) throw new Error('非法候选路径');
      const bytes = await readFile(join(round, c.path));
      if (sha(bytes) !== c.sha256) throw new Error('候选与交回指纹不符');
      const document = JSON.parse(bytes.toString('utf8')); return { name: document.name, document };
    }));
    const names = new Set(candidates.map((c) => c.name));
    measurement = await measure({ ...base, templates: [...base.templates.filter((t) => !names.has(t.name)), ...candidates] }, control, dir);
  } else await mkdir(dir, { recursive: true });
  const result = { caseId, round, qualified: record.verdict === 'qualified', available: !!measurement,
    ...repairDelta(initial.checks, measurement?.checks ?? null, spec.targets.map((id) => 'base/' + id), record.verdict === 'qualified'), measurement };
  await save(join(dir, 'report.json'), result);
  await writeFile(join(dir, 'image-feedback.md'), next + '\n');
  await writeFile(join(dir, 'evidence-feedback.md'), next + '\n\n' + (measurement?.feedback ?? '当前没有可用的交回布局证据，先保存有效成果。') + '\n');
  if (manifest.comparison === 'role-region') {
    const expected = await json(join(root, 'control-score/report.json'));
    const decision = { ...repairStopDecision(expected.checks.map((c: RepairCheck) => c.id), measurement?.checks ?? null, result.qualified),
      decidedAt: new Date().toISOString(), templateSha256: measurement?.templateSha256 ?? null, measurementSha256: sha(await readFile(join(dir, 'report.json'))) };
    await save(join(dir, 'stop-decision.json'), decision);
    await writeFile(join(dir, 'role-feedback.md'), next + '\n\n' + (measurement?.feedback ?? '当前没有可用的交回布局证据，先保存有效成果。') + '\n');
    await writeFile(join(dir, 'region-feedback.md'), next + '\n\n' + (measurement ? boundedRepairFeedback(measurement.checks.filter(c => c.id.startsWith('base/') && c.role !== 'render'), REPAIR_REGIONS) : '当前没有可用的交回布局证据，先保存有效成果。') + '\n');
  }
  return { caseId, repaired: result.repaired, added: result.addedFailures, qualified: result.qualified };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { prepare: { type: 'string' }, comparison: { type: 'string' }, root: { type: 'string' }, case: { type: 'string' }, round: { type: 'string' } }, strict: true });
  if (values.comparison && !['image-evidence', 'role-region'].includes(values.comparison)) throw new Error('未知对照类型');
  if (values.prepare) console.log(JSON.stringify(await prepareRepairExperiment(resolve(values.prepare), values.comparison as 'image-evidence' | 'role-region' | undefined)));
  else if (values.root && values.case && values.round) console.log(JSON.stringify(await scoreRepairRound(resolve(values.root), values.case, resolve(values.round))));
  else throw new Error('需要 --prepare <新目录> 或 --root <试验目录> --case <a|b|c> --round <轮次>');
}
