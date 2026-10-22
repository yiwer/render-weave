/** 受控交接试验：显式设置阈值，只在 contextLimit 停止后接续一次；不重试质量失败。 */
import { parseArgs } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runAgentTask } from '../dist/index.js';

const { values } = parseArgs({ options: { baseline: { type: 'string' }, out: { type: 'string' }, limit: { type: 'string' } }, strict: true });
if (!values.baseline || !values.out || !Number.isSafeInteger(Number(values.limit)) || Number(values.limit) < 1) throw new Error('需要 --baseline <本版无阈值轮次> --out <新目录> --limit <正整数>');
const key = process.env.OPEN_CODE_API_KEY;
if (!key) throw new Error('缺少 OPEN_CODE_API_KEY');
const base = resolve(values.baseline), out = resolve(values.out);
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const baseline = await json(join(base, 'round.json'));
if (baseline.task !== 'template-design' || baseline.runtime.contextLimit) throw new Error('基线应为没有阈值的新建模板轮次');
await mkdir(out);
const runtime = { key, keyEnv: 'OPEN_CODE_API_KEY', model: baseline.runtime.model, smallModel: baseline.runtime.smallModel,
  endpoint: baseline.runtime.endpoint, maxTurns: baseline.runtime.maxTurns, ...(baseline.runtime.effort ? { effort: baseline.runtime.effort } : {}) };
const first = await runAgentTask({ ...runtime, task: 'template-design', sample: join(base, baseline.inputs.sample.file),
  brief: join(base, 'agent/docs/brief.md'), resources: baseline.inputs.resources, workspace: join(base, 'snapshot'),
  dataset: baseline.inputs.dataset, request: join(base, 'request.json'), ...(baseline.inputs.domain ? { domain: baseline.inputs.domain } : {}),
  ...(baseline.inputs.checks ? { checks: join(base, 'design-checks.json') } : {}), out: join(out, 'stopped'), contextLimit: Number(values.limit) });
console.log(JSON.stringify({ round: 'stopped', verdict: first.record.verdict, peak: first.record.run.context?.peakInputTokens, stopped: first.record.run.contextStopped }));
let resumed;
if (first.record.run.contextStopped) {
  resumed = await runAgentTask({ ...runtime, from: first.roundDir, feedback: join(first.roundDir, 'handoff-feedback.md'), out: join(out, 'resumed') });
  console.log(JSON.stringify({ round: 'resumed', verdict: resumed.record.verdict, peak: resumed.record.run.context?.peakInputTokens }));
}
const summarize = (r) => ({ verdict: r.verdict, peakInputTokens: r.run.context?.peakInputTokens, requests: r.run.context?.requests,
  outputTokens: r.run.outputTokens, wallMs: r.run.wallMs, stopped: r.run.contextStopped ?? null });
const report = { baseline: { dir: base, ...summarize(baseline) }, limit: Number(values.limit), first: summarize(first.record),
  resumed: resumed ? summarize(resumed.record) : null, note: '单次受控实验；各轮峰值取最大，计费用量与时间相加。接续不等于质量通过，须另外运行原场景评分。' };
await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
