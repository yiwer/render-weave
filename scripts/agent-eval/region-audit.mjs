/** 对已完成真实批次独立复算关键指标与时间顺序；只读输入，输出审计摘要。 */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import { loadWorkspace } from '../../dist/index.js';
const { values } = parseArgs({ options: { root: { type: 'string' }, out: { type: 'string' } }, strict: true });
if (!values.root || !values.out) throw new Error('需要 --root 与 --out 报告目录');
const root = resolve(values.root), out = resolve(values.out), repo = resolve(import.meta.dirname, '../..');
const json = async p => JSON.parse(await readFile(p, 'utf8'));
const hash = async p => createHash('sha256').update(await readFile(p)).digest('hex');
const manifest = await json(join(root, 'manifest.json')), live = await json(join(root, 'live-report.json')), report = await json(join(out, 'report.json'));
assert.equal(live.manifestSha256, await hash(join(root, 'manifest.json')));
assert.equal(report.manifestSha256, live.manifestSha256);
assert.equal(live.rows.length, manifest.order.length);
assert(live.rows.every(r => r.status === 'completed' && r.rounds.length === 2), '不完整批次不能声称审计全部通过');
for (const [dir, files] of [['', manifest.scripts], ['src', manifest.engine], ['dist', manifest.runtime], ['agent', manifest.materials], ['fixtures/resources', manifest.resources]]) {
  for (const f of files) assert.equal(await hash(join(repo, dir, f.path)), f.sha256, dir + '/' + f.path);
}
for (const f of manifest.inputs) assert.equal(await hash(join(root, f.path)), f.sha256, f.path);
const expected = (await json(join(root, 'control-score/report.json'))).checks.map(c => c.id).sort();
const initial = (await json(join(root, 'c/initial/report.json'))).checks;
const targets = manifest.cases[0].targets.map(t => 'base/' + t);
const verified = []; let requests = 0, maxFeedbackChars = 0;
for (const item of live.rows) {
  const rounds = [];
  for (const [i, round] of item.rounds.entries()) {
    const rec = await json(join(round.dir, 'round.json')), context = await json(join(round.dir, 'context.json'));
    assert.deepEqual(rec, round.record);
    assert.equal(rec.runtime.model, 'claude-haiku-5-5'); assert.equal(rec.runtime.smallModel, rec.runtime.model);
    assert.equal(rec.run.servedModel, rec.runtime.model); assert.equal(rec.runtime.maxTurns, 20);
    assert.equal(rec.runtime.keyEnv, 'OPEN_CODE_API_KEY'); assert.equal(rec.runtime.skills, 'disabled');
    const events = (await readFile(join(round.dir, 'logs/stream.jsonl'), 'utf8')).trim().split('\n').map(s => JSON.parse(s));
    const init = events.find(e => e.type === 'system' && e.subtype === 'init');
    assert.equal(init.model, rec.runtime.model); assert.deepEqual(init.skills, []);
    assert.equal(init.tools.length, 13); assert.deepEqual(init.mcp_servers.map(s => s.name), ['rw']);
    for (const q of context.requests) assert.equal(q.effectiveInputTokens, q.inputTokens + q.cacheReadTokens + q.cacheCreationTokens);
    const peak = Math.max(...context.requests.map(q => q.effectiveInputTokens));
    assert.equal(peak, context.peakInputTokens); assert.equal(peak, rec.run.context.peakInputTokens);
    requests += context.requests.length;
    const score = await json(join(round.dir, 'repair-score/report.json')), decision = await json(join(round.dir, 'repair-score/stop-decision.json'));
    const checks = score.measurement?.checks;
    if (score.measurement) {
      const ws = await loadWorkspace({ dir: join(round.dir, 'snapshot'), resourcesDir: join(repo, 'fixtures/resources') });
      const outcome = await json(join(round.dir, 'outcome.json')), candidates = [];
      for (const c of outcome.candidates.filter(c => c.kind === 'template')) {
        assert(/^candidates\/[^:]+\.json$/.test(c.path) && !c.path.split(/[\\/]/).includes('..'));
        assert.equal(await hash(join(round.dir, c.path)), c.sha256);
        const document = await json(join(round.dir, c.path)); candidates.push({ name: document.name, document });
      }
      const names = new Set(candidates.map(c => c.name));
      const templates = [...ws.templates.filter(t => !names.has(t.name)), ...candidates];
      const digest = createHash('sha256').update(JSON.stringify(templates.map(t => [t.name, t.document]))).digest('hex');
      assert.equal(digest, score.measurement.templateSha256, '实际候选必须匹配评分与停止决定');
    }
    const complete = !!checks && new Set(checks.map(c => c.id)).size === checks.length && JSON.stringify(checks.map(c => c.id).sort()) === JSON.stringify(expected);
    assert.equal(decision.stop, rec.verdict === 'qualified' && complete && checks.every(c => c.pass));
    assert.equal(decision.measurementSha256, await hash(join(round.dir, 'repair-score/report.json')));
    assert.equal(decision.templateSha256, score.measurement?.templateSha256 ?? null);
    assert.deepEqual(decision, round.stopDecision);
    if (i === 0) assert(Date.parse(decision.decidedAt) < Date.parse(item.rounds[1].record.startedAt));
    assert.deepEqual(score.repaired, targets.filter(id => checks?.find(c => c.id === id)?.pass));
    assert.deepEqual(score.addedFailures, checks ? initial.filter(c => c.pass && checks.find(x => x.id === c.id)?.pass !== true).map(c => c.id) : null);
    const feedback = await readFile(i === 0 ? join(root, 'c', item.arm + '.md') : join(round.dir, 'feedback.md'), 'utf8');
    const start = feedback.indexOf('宿主元素测量');
    if (start < 0) assert(i === 1 && !rounds[0].checks && feedback.includes('当前没有可用的交回布局证据'));
    const packet = start >= 0 ? feedback.slice(start).trim() : '', entries = start >= 0 ? JSON.parse(packet.split('\n')[1]) : [];
    assert(entries.length <= 2); assert(packet.length <= 1200); maxFeedbackChars = Math.max(maxFeedbackChars, packet.length);
    if (item.arm === 'region') assert.equal(new Set(entries.map(e => manifest.regions[e.role] ?? e.role)).size, entries.length);
    const archived = report.rows.find(r => r.id === item.id).rounds[i];
    for (const file of Object.values(archived.archived)) assert.equal(await hash(join(out, file.file)), file.sha256);
    const calls = new Map(); for (const e of events) for (const b of e.message?.content ?? []) if (b.type === 'tool_use') calls.set(b.id, b);
    rounds.push({ iteration: i + 1, peak, wallMs: rec.run.wallMs, stop: decision.stop, repaired: checks ? score.repaired.length : null, added: score.addedFailures,
      checks: checks ?? null, promptSha256: await hash(join(round.dir, 'logs/prompt.md')), mcpConfigSha256: await hash(join(round.dir, 'logs/mcp.json')),
      tools: calls.size, layoutCalls: [...calls.values()].filter(c => c.name === 'mcp__rw__inspect_layout').length });
  }
  verified.push({ id: item.id, arm: item.arm, rounds });
}
for (const repetition of [1, 2]) {
  const pair = ['role', 'region'].map(arm => live.rows.find(r => r.repetition === repetition && r.arm === arm).rounds[0]);
  for (const key of ['workspace', 'templates', 'dataset', 'domain', 'resources']) assert.deepEqual(pair[0].record.inputs[key], pair[1].record.inputs[key]);
  for (const key of ['sample', 'brief']) assert.equal(pair[0].record.inputs[key].sha256, pair[1].record.inputs[key].sha256);
  assert.equal(await hash(join(pair[0].dir, 'request.json')), await hash(join(pair[1].dir, 'request.json')));
}
for (const arm of ['role', 'region']) for (const policy of ['first', 'fixed', 'stopped']) {
  const units = verified.filter(r => r.arm === arm).map(r => {
    const prefix = r.rounds.slice(0, policy === 'first' || policy === 'stopped' && r.rounds[0].stop ? 1 : 2), last = prefix.at(-1);
    return { repaired: last.repaired, allPassed: last.checks ? last.stop : null, added: last.added?.length ?? null,
      regressions: prefix[0].checks && last.checks ? prefix[0].checks.filter(c => c.pass && last.checks.find(f => f.id === c.id)?.pass !== true).length : null,
      peak: Math.max(...prefix.map(x => x.peak)), wallMs: prefix.reduce((s, x) => s + x.wallMs, 0), rounds: prefix.length };
  });
  const g = report.groups[arm][policy];
  assert.equal(g.repaired, units.reduce((s, r) => s + r.repaired, 0));
  assert.equal(g.allPassed, units.filter(r => r.allPassed).length);
  assert.equal(g.addedFailures, units.reduce((s, r) => s + r.added, 0));
  assert.equal(g.regressions, units.reduce((s, r) => s + r.regressions, 0));
  assert.equal(g.unknownRepair, units.filter(r => r.repaired === null).length);
  assert.equal(g.unknownAdded, units.filter(r => r.added === null).length);
  assert.equal(g.unknownAllPassed, units.filter(r => r.allPassed === null).length);
  assert.equal(g.unknownRegressions, units.filter(r => r.regressions === null).length);
  assert.equal(g.meanPeak, units.reduce((s, r) => s + r.peak, 0) / units.length);
  assert.equal(g.maximumPeak, Math.max(...units.map(r => r.peak)));
  assert.equal(g.meanWallMs, units.reduce((s, r) => s + r.wallMs, 0) / units.length);
  assert.equal(g.totalWallMs, units.reduce((s, r) => s + r.wallMs, 0));
  assert.equal(g.modelRounds, units.reduce((s, r) => s + r.rounds, 0));
}
const audit = { passed: true, manifestSha256: live.manifestSha256, units: verified.length, rounds: verified.reduce((s, u) => s + u.rounds.length, 0), requests, maxFeedbackChars,
  runtime: { model: manifest.model, tools: 13, skills: [], mcp: ['rw'] },
  checks: ['冻结指纹', '成对输入相同', '实际模型/工具/skills', '每请求有效输入与峰值', '候选与决定哈希', '停止决定先于第二轮', '反馈预算与区域去重', '归档文件哈希', '各策略修复/新增/回退/成本独立复算'],
  verified: verified.map(r => ({ ...r, rounds: r.rounds.map(({ checks, ...round }) => ({ ...round, remaining: checks?.filter(c => !c.pass).map(c => c.id) ?? null })) })) };
await writeFile(join(out, 'audit.json'), JSON.stringify(audit, null, 2) + '\n');
console.log(JSON.stringify({ passed: audit.passed, units: audit.units, rounds: audit.rounds, requests, maxFeedbackChars }));
