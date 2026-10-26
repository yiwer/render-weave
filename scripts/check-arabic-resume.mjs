/** 独立核对原中断候选的真实接续结果；不调用模型、不批准或应用成果。 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { compareReference, loadWorkspace, render } from '../src/index.ts';

const original = resolve(process.argv[2] ?? 'out/arabic-board-retest-2026-10-20');
const roundDir = resolve(process.argv[3] ?? join(original, 'r3b-template'));
const output = resolve(process.argv[4] ?? 'out/arabic-resume-verification');
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const round = await json(join(roundDir, 'round.json'));
const check = await json(join(roundDir, 'check.json'));
assert.equal(round.run.endedBy, 'success', '真实模型须正常交回，不能以宿主恢复草稿代替模型成果');
assert.equal(resolve(round.inputs.previous.dir), join(original, 'r3-template'));
const outcome = await json(join(roundDir, 'outcome.json'));
assert.equal(outcome.candidates.length, 3, '本次须保留三个已有模板');
const templates = await Promise.all(outcome.candidates.map(async (entry) => ({ name: entry.name, document: await json(join(roundDir, entry.path)), source: entry.path })));
const workspace = await loadWorkspace({ dir: join(roundDir, 'snapshot'), resourcesDir: join(original, 'resources') });
const overlay = { ...workspace, templates: [...workspace.templates.filter((t) => !templates.some((c) => c.name === t.name)), ...templates] };
const request = await json(join(roundDir, 'request.json'));
const baseline = await json('docs/examples/arabic-reference/reference.json');
const sample = { path: join(original, 'r3-template/agent/sample.png'), sha256: baseline.sampleSha256 };
const result = await compareReference({ workspace: overlay, request, baseline, sample, regions: ['stop-1-ar', 'stop-6-ar', 'stop-16-ar'], includeImages: true });
const final = await render(overlay, { ...request, mode: 'final' });
assert.equal(final.image, undefined);
const formalSevereCodes = [...new Set(final.problems.filter((p) => p.level === 'severe').map((p) => p.code))].sort();
assert.deepEqual(formalSevereCodes, ['text.unshapedScript'], '不接受塑形以外的新增严重错误');
assert.equal(check.verdict, 'unqualified'); assert.equal(check.assessment.render.capabilityBlocked, true);
const old = await json('out/arabic-reference-comparison/summary.json');
assert.equal(old.inputCandidates.length, 3, '必须核对全部三个原候选，不能空跑');
assert.equal(new Set(old.inputCandidates.map((entry) => basename(entry.source))).size, 3, '原候选名称必须唯一');
for (const entry of old.inputCandidates) assert.equal(createHash('sha256').update(await readFile(join(original, 'r3-template/agent/candidates', basename(entry.source)))).digest('hex'), entry.sha256, '原中断候选必须保持原样');
const logs = (await readFile(join(roundDir, 'logs/model-proxy.jsonl'), 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
const calls = logs.filter((event) => event.status === 200);
assert.ok(calls.length > 0, '必须有真实成功调用记录');
const counts = {};
for (const anomaly of result.report.anomalies) counts[anomaly.kind] = (counts[anomaly.kind] ?? 0) + 1;
const summary = { round: roundDir, usage: round.run, verdict: check.verdict, capabilityBlocked: check.assessment.render.capabilityBlocked,
  submitted: true, oldCandidatesUnchanged: true, formalImage: false, formalSevereCodes,
  coverage: result.report.coverage, counts,
  heights: result.report.regions.filter((r) => /^stop-\d+-ar$/.test(r.id)).map((r) => ({ id: r.id, state: r.state, instances: r.instances.length,
    fontSizeMm: r.instances[0]?.fontSizeMm, heightRatio: r.instances[0]?.sizeRatio?.height })),
  successfulCalls: calls.length, maxSuccessfulCallMs: Math.max(0, ...calls.map((event) => event.ms)), callsOver300s: calls.filter((event) => event.ms > 300000).length,
  limits: ['旧轮次未带参考，模型工具保持notChecked；本报告是独立宿主对照，不冒充模型已用86区域反馈', '恢复路径与能力阻塞验收不代表样式通过', '基准非客户批准，最终可见性仍未知'] };
await mkdir(output, { recursive: true });
await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2));
await writeFile(join(output, 'report.json'), JSON.stringify(result.report, null, 2));
await writeFile(join(output, 'final-problems.json'), JSON.stringify(final.problems, null, 2));
await writeFile(join(output, 'content.png'), result.render.evidence.image.bytes);
for (const panel of result.panels) await writeFile(join(output, `${panel.regionId}.png`), panel.bytes);
console.log(JSON.stringify(summary, null, 2));
