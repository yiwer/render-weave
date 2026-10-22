/** 重放已保存轮次的宿主核查，输出 JSON、同尺度诊断图；不调用模型。 */
import { parseArgs } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadWorkspace, parseDesignCheckPlan, verifyTemplateDesign, render } from '../dist/index.js';

const { values } = parseArgs({ options: { round: { type: 'string' }, plan: { type: 'string' }, out: { type: 'string' } }, strict: true });
if (!values.round || !values.out) throw new Error('用法：node scripts/verify-template-design.mjs --round <轮次> [--plan <计划>] --out <新目录>');
const round = resolve(values.round), out = resolve(values.out);
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const record = await json(join(round, 'round.json'));
const outcome = await json(join(round, 'outcome.json'));
const plan = parseDesignCheckPlan(await json(values.plan ?? join(round, 'design-checks.json')));
const request = await json(join(round, 'request.json'));
const sample = await readFile(join(round, record.inputs.sample.file));
const workspace = await loadWorkspace({ dir: join(round, 'snapshot'), resourcesDir: record.inputs.resources });
const candidates = await Promise.all(outcome.candidates.map(async (c) => {
  if (!/^candidates\/[^:]+\.json$/.test(c.path) || c.path.split(/[\\/]/).includes('..')) throw new Error('候选路径不合法');
  return { path: c.path, kind: c.kind, document: await json(join(round, c.path)) };
}));
const { report, heatmap } = await verifyTemplateDesign({ workspace, candidates, request, plan, sample });
await mkdir(out); // 不覆盖前一次核查
await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
await writeFile(join(out, 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
await writeFile(join(out, 'reference.png'), sample);
if (heatmap) await writeFile(join(out, 'heatmap.png'), heatmap);
const templates = candidates.filter((c) => c.kind === 'template').map((c) => ({ name: c.document.name, document: c.document }));
const names = new Set(templates.map((t) => t.name));
const picture = await render({ ...workspace, templates: [...workspace.templates.filter((t) => !names.has(t.name)), ...templates] },
  { ...request, mode: 'draft', output: { ...request.output, dpi: Math.min(request.output.dpi ?? 100, 100), format: 'png' } });
if (picture.image) await writeFile(join(out, 'actual.png'), picture.image.bytes);
console.log(JSON.stringify({ status: report.status, failureCount: report.failureCount, cases: report.cases.map((c) => ({ id: c.id, passed: c.passed })),
  visual: report.visual, report: join(out, 'report.json') }, null, 2));
process.exitCode = report.status === 'passed' ? 0 : 1;
