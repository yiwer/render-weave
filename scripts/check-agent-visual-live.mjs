/** 校验真实模型成果与工具日志，不调用模型、不改候选。 */
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { compareReference, loadWorkspace } from '../src/index.ts';

const root = resolve(process.argv[2] ?? 'out/agent-visual-live');
const roundDir = resolve(process.argv[3] ?? join(root, 'round-1'));
const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
const round = await json(join(roundDir, 'round.json')), check = await json(join(roundDir, 'check.json'));
assert.equal(round.run.endedBy, 'success'); assert.equal(check.verdict, 'qualified');
const tools = (await readFile(join(roundDir, 'logs/tools.jsonl'), 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
const comparisons = tools.filter((event) => event.tool === 'compare_reference' && !event.isError);
assert.ok(comparisons.length >= 2);
assert.equal(comparisons[0].status, 'needsWork'); assert.equal(comparisons.at(-1).status, 'needsReview');
assert.notEqual(comparisons[0].reportId, comparisons.at(-1).reportId);
assert.equal(comparisons.at(-1).reportId, check.assessment.visual.reportId);
assert.equal(check.assessment.visual.anomaliesTotal, 0); assert.equal(check.assessment.visual.coverage.unknownRegions, 2);
const initial = await json(join(root, 'workspace/template.json'));
const expected = structuredClone(initial), node = expected.artboard.children[0];
node.content = [{ text: '科技园' }]; node.fontSize = 10; node.color = '#172B4D'; node.place.left = 10;
const candidate = await json(join(roundDir, 'candidates/template.json'));
assert.deepEqual(candidate, expected, '仅允许约定四项修改，页脚和其它结构应保持不变');
const workspace = await loadWorkspace({ dir: join(root, 'workspace'), resourcesDir: 'fixtures/resources' });
const request = await json(join(root, 'request.json')), baseline = await json(join(root, 'reference.json'));
const sample = { path: join(root, 'sample.png'), sha256: baseline.sampleSha256 };
const output = resolve(process.argv[4] ?? join(root, 'verified')); await mkdir(output, { recursive: true });
const reports = [];
for (const [id, document] of [['before', initial], ['after', candidate]]) {
  const result = await compareReference({ workspace: { ...workspace, templates: [{ name: candidate.name, document, source: 'template.json' }] }, request, baseline, sample, includeImages: true });
  reports.push({ id, anomalies: result.report.anomalies.length, kinds: [...new Set(result.report.anomalies.map((a) => a.kind))], status: result.report.status });
  await writeFile(join(output, `${id}-report.json`), JSON.stringify(result.report, null, 2));
  await writeFile(join(output, `${id}-content.png`), result.render.evidence.image.bytes);
  for (const panel of result.panels) await writeFile(join(output, `${id}-${panel.regionId}.png`), panel.bytes);
}
assert.equal(reports[1].anomalies, 0);
const summary = { model: round.run.servedModel, usage: round.run, toolErrors: tools.filter((event) => event.isError), comparisons,
  hostReportId: check.assessment.visual.reportId, reports, allowedChangesOnly: true, source: await json(join(roundDir, 'logs/provenance.json')),
  limits: ['一次受控样例，不是总体成功率', '对照图来自预先定义的合成真值，不证明真实图标注质量', '真实运行使用启动时dist构建；verified是当前源码离线复核，构建哈希不同', '最终可见性仍未核查'] };
await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ model: summary.model, wallMs: round.run.wallMs, turns: round.run.turns, reports, toolErrors: summary.toolErrors.length }));
