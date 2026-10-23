const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve('out/repair-feedback-live');
const dest = path.resolve(process.argv[2] || 'docs/agent-eval/figures/template-repair-feedback');
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const manifest = read(path.join(root, 'manifest.json'));
const live = read(path.join(root, 'live-report.json'));
const report = read(path.join(dest, 'report.json'));
assert.equal(live.manifestSha256, sha(path.join(root, 'manifest.json')));
assert.equal(report.manifestSha256, live.manifestSha256);
assert.equal(live.rows.length, 12);
assert(live.rows.every(r => r.status === 'completed' && r.rounds.length === 2));
for (const [directory, files] of [['', manifest.scripts], ['src', manifest.engine], ['dist', manifest.runtime], ['agent', manifest.materials], ['fixtures/resources', manifest.resources]]) {
  for (const f of files) assert.equal(sha(path.join(directory, f.path)), f.sha256, f.path);
}
for (const f of manifest.inputs) assert.equal(sha(path.join(root, f.path)), f.sha256, f.path);
let requests = 0, rounds = 0, feedbackPackets = 0, maxFeedbackChars = 0, maxFeedbackItems = 0;
const verified = [];
for (const item of live.rows) {
  const initial = read(path.join(root, item.caseId, 'initial/report.json'));
  const targets = manifest.cases.find(c => c.id === item.caseId).targets.map(t => 'base/' + t);
  const measured = [];
  for (let i = 0; i < item.rounds.length; i++) {
    const r = item.rounds[i]; const rec = read(path.join(r.dir, 'round.json'));
    assert.deepEqual(rec, r.record);
    assert.equal(rec.runtime.model, manifest.model); assert.equal(rec.runtime.smallModel, manifest.model);
    assert.equal(rec.run.servedModel, manifest.model); assert.equal(rec.runtime.maxTurns, 20);
    assert.equal(rec.runtime.skills, 'disabled'); assert.equal(rec.runtime.keyEnv, 'OPEN_CODE_API_KEY');
    assert.equal(rec.runtime.effort, null); assert.equal(rec.runtime.contextLimit, null);
    const events = fs.readFileSync(path.join(r.dir, 'logs/stream.jsonl'), 'utf8').trim().split('\n').map(s => JSON.parse(s));
    const startup = events.find(e => e.type === 'system' && e.subtype === 'init');
    assert.equal(startup.model, manifest.model); assert.deepEqual(startup.skills, []);
    assert.equal(startup.tools.length, 13); assert.deepEqual(startup.mcp_servers.map(s => s.name), ['rw']);
    const context = read(path.join(r.dir, 'context.json'));
    for (const req of context.requests) assert.equal(req.effectiveInputTokens, req.inputTokens + req.cacheReadTokens + req.cacheCreationTokens);
    const peak = Math.max(...context.requests.map(q => q.effectiveInputTokens));
    assert.equal(peak, context.peakInputTokens); assert.equal(peak, rec.run.context.peakInputTokens);
    assert.equal(context.requests.length, rec.run.context.requests);
    requests += context.requests.length; rounds++;
    const score = read(path.join(r.dir, 'repair-score/report.json'));
    assert.deepEqual(read(path.join(dest, item.id + '-round-' + (i + 1) + '.json')), score);
    const checks = score.measurement?.checks;
    assert.deepEqual(score.repaired, targets.filter(t => checks?.find(c => c.id === t)?.pass));
    assert.deepEqual(score.addedFailures, checks ? initial.checks.filter(c => c.pass && checks.find(x => x.id === c.id)?.pass !== true).map(c => c.id) : null);
    assert.equal(score.cleanSuccess, score.qualified && score.repaired.length === 2 && score.addedFailures?.length === 0);
    if (item.arm === 'evidence') {
      const packetPath = i === 0 ? path.join(root, item.caseId, 'evidence.md') : path.join(r.dir, 'feedback.md');
      const packet = fs.readFileSync(packetPath, 'utf8');
      const start = packet.indexOf('宿主元素测量'); assert(start >= 0);
      const chunk = packet.slice(start).trim(); const entries = JSON.parse(chunk.split('\n')[1]);
      assert(entries.length <= 2); assert(chunk.length <= 1200);
      feedbackPackets++; maxFeedbackItems = Math.max(maxFeedbackItems, entries.length); maxFeedbackChars = Math.max(maxFeedbackChars, chunk.length);
    }
    measured.push({ peak, wallMs: rec.run.wallMs, score });
  }
  const finalChecks = measured[1].score.measurement.checks;
  verified.push({ id: item.id, arm: item.arm, peak: Math.max(...measured.map(m => m.peak)), wallMs: measured.reduce((s, m) => s + m.wallMs, 0), repaired: measured[1].score.repaired.length, added: measured[1].score.addedFailures?.length ?? null, qualified: measured[1].score.qualified, clean: measured[1].score.cleanSuccess,
    remaining: finalChecks.filter(c => !c.pass).length, regressed: measured[0].score.measurement.checks.filter(c => c.pass && finalChecks.find(f => f.id === c.id)?.pass !== true).length });
}
for (const c of manifest.cases) for (const rep of [1, 2]) {
  const pair = ['image', 'evidence'].map(a => live.rows.find(r => r.id === `${c.id}-${rep}-${a}`).rounds[0].record);
  for (const key of ['workspace', 'templates', 'dataset', 'domain', 'resources']) assert.deepEqual(pair[0].inputs[key], pair[1].inputs[key]);
  assert.equal(pair[0].inputs.sample.sha256, pair[1].inputs.sample.sha256);
  assert.equal(pair[0].inputs.brief.sha256, pair[1].inputs.brief.sha256);
  assert.equal(sha(path.join(live.rows.find(r => r.id === `${c.id}-${rep}-image`).rounds[0].dir, 'request.json')), sha(path.join(live.rows.find(r => r.id === `${c.id}-${rep}-evidence`).rounds[0].dir, 'request.json')));
}
const aggregates = {};
for (const arm of ['image', 'evidence']) {
  const rows = verified.filter(r => r.arm === arm);
  const g = { completed: rows.length, repaired: rows.reduce((s, r) => s + r.repaired, 0), targets: rows.length * 2, addedFailures: rows.reduce((s, r) => s + (r.added || 0), 0), unknownAddedUnits: rows.filter(r => r.added === null).length, qualified: rows.filter(r => r.qualified).length, cleanSuccess: rows.filter(r => r.clean).length, meanPeak: rows.reduce((s, r) => s + r.peak, 0) / rows.length, maximumPeak: Math.max(...rows.map(r => r.peak)), meanWallMs: rows.reduce((s, r) => s + r.wallMs, 0) / rows.length, totalWallMs: rows.reduce((s, r) => s + r.wallMs, 0) };
  for (const [key, value] of Object.entries(g)) { assert.equal(report.groups[arm][key], value, arm + '/' + key); assert.equal(report.pairedGroups[arm][key], value, 'paired/' + arm + '/' + key); }
  const allChecks = { allPassedUnits: rows.filter(r => r.qualified && r.remaining === 0).length, remainingFailures: rows.reduce((s, r) => s + r.remaining, 0), unknownRemainingUnits: 0, regressedFromFirst: rows.reduce((s, r) => s + r.regressed, 0), unknownRegressionUnits: 0 };
  assert.deepEqual(report.groups[arm].exploratoryAllChecks, allChecks);
  assert.deepEqual(report.pairedGroups[arm].exploratoryAllChecks, allChecks);
  aggregates[arm] = { ...g, exploratoryAllChecks: allChecks };
}
const audit = { passed: true, scriptSha256: sha(__filename), manifestSha256: live.manifestSha256, units: verified.length, rounds, requests, feedbackPackets, maxFeedbackItems, maxFeedbackChars, inputPairsIdentical: 6, runtime: { model: manifest.model, smallModel: manifest.model, maxTurns: 20, tools: 13, skills: [], mcp: ['rw'] }, aggregates, checks: ['冻结源代码/运行构建/资料/输入/资源指纹', '成对首轮输入相同（额外反馈除外）', '24轮真实运行记录与模型/技能/工具配置', '逐请求有效输入加总与峰值', '新增反馈条数和字符界限', '归档分数等于原记录，目标恢复及新增失败独立复算', '两轮总耗时和峰值、全样本及成对汇总独立复算'] };
fs.writeFileSync(path.join(dest, 'audit.json'), JSON.stringify(audit, null, 2) + '\n');
console.log(JSON.stringify(audit));
