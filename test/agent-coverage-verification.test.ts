import { describe, expect, it } from 'vitest';
import { checkAgentOutcome, verifyExtractionCoverage, createMemoryResourceRepository, loadWorkspace, type BusinessContentBaseline, type SubmittedOutcome } from '../src/index.js';
import { resourcesDir, singleTextDir } from './support/fixtures.js';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startMcp } from './support/mcp-client.js';

const candidate = (name: string, fields: unknown[]) => ({ path: `candidates/${name}.json`, kind: 'definition' as const, name, problems: [], document: { dslVersion: 'renderweave-schema/1', name, fields } });
const stop = candidate('停靠站点', [{ name: 'code', displayName: '编号', type: 'text', constraints: { required: true } }]);
const baseline: BusinessContentBaseline = { name: '本次核准样例', items: [
  { id: 'stopCode', label: '站码', definition: '停靠站点', field: 'code', expectedKind: 'field', sampleOmissions: 15, mustBeOptionalIfPartial: true },
  { id: 'paymentMethods', label: '付款方式', allowConstantWithoutBrief: false },
] };
const submission: SubmittedOutcome = { candidates: [stop.path], pending: [], notes: '已核对' };

describe('提取事实来自本次基准', () => {
  it('大量内容遗漏在 MCP 预算内保留不合格结论、遗漏总数与分类计数', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rw-coverage-budget-'));
    try {
      await mkdir(join(dir, 'candidates'));
      await writeFile(join(dir, stop.path), JSON.stringify(stop.document));
      await writeFile(join(dir, 'outcome.json'), JSON.stringify(submission));
      const context = join(dir, 'context.json');
      await writeFile(context, JSON.stringify({ task: 'definition-extraction', contentBaseline: { name: '完整字段事实', items: Array.from({ length: 400 }, (_, i) => ({
        id: `field-${i}`, label: `核准业务字段${i}`, definition: '停靠站点', field: `field${i}`, expectedKind: 'field',
      })) } }));
      const session = startMcp(['--workspace', singleTextDir, '--resources', resourcesDir, '--root', dir, '--outcome-context', context]);
      try {
        await session.request('initialize', { protocolVersion: '2025-06-18' });
        const result = await session.call('check_outcome');
        expect(result.isError).toBe(false);
        const text = result.content.find((c) => c.type === 'text')! as { text: string };
        expect(text.text.length).toBeLessThanOrEqual(40000);
        const checked = JSON.parse(text.text), coverage = checked.assessment.coverage;
        expect(checked.verdict).toBe('unqualified'); expect(coverage.status).toBe('needsWork');
        expect(coverage.passed).toBe(false); expect(coverage.score).toBeNull();
        expect(coverage.detailsTruncated.byCode.missingCoverageItem).toBe(400);
        expect(coverage.detailsTruncated.fields).toContainEqual({ field: 'anomalies', shown: coverage.anomalies.length, total: 400 });
        expect(coverage.detailsTruncated.fields.find((field: { field: string }) => field.field === 'missingItems')?.total ?? coverage.missingItems.length).toBe(400);
        expect(coverage.anomalies[0].path).toBe('停靠站点.field0');
      } finally { await session.close(); }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('待确认候选与预览一致，Windows 等价路径不会变成编造，仍保留审核', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rw-coverage-pending-'));
    try {
      await mkdir(join(dir, 'candidates'));
      const workspace = await loadWorkspace({ dir: singleTextDir, resourcesDir });
      await writeFile(join(dir, 'candidates/data.json'), JSON.stringify({ dataset: { id: 'pending-greeting', staticSchema: { name: '问候', version: 1 } }, data: {} }));
      for (const file of ['candidates/data.json', './candidates/data.json', 'candidates\\data.json']) {
        await writeFile(join(dir, 'outcome.json'), JSON.stringify({ candidates: ['candidates/data.json'], pending: [{ file, path: 'message', candidate: '欢迎乘坐', reason: 'inferred', note: '待确认' }], notes: '提取草稿' }));
        for (const fact of [{ path: 'message', value: '欢迎乘坐' }, { path: 'message', unknown: true }]) {
          const result = await checkAgentOutcome({ task: 'dataset-extraction', agentDir: dir, workspace, context: { definition: { name: '问候', version: 1 }, contentBaseline: { name: '核准事实', items: [{ id: 'message', label: '文字', values: [fact] }] } } });
          expect(result.verdict).toBe('qualified'); expect(result.assessment.coverage?.status).toBe('needsReview');
          expect(result.assessment.coverage?.passed).toBe(false);
          expect(result.assessment.coverage?.unknownItems).toContain('message');
        }
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('商品 code 与没有基准的线路牌均不会被套上 15 处缺编号', () => {
    for (const entry of [stop, candidate('商品', [{ name: 'code', type: 'text', constraints: { required: true } }])]) {
      const report = verifyExtractionCoverage({ task: 'definition-extraction', candidates: [entry], submission });
      expect(report.status).toBe('notChecked'); expect(report.anomalies).toEqual([]); expect(report.score.totalScore).toBeNull();
    }
  });
  it('核准的 15 处缺值只约束映射字段；解释不能覆盖候选的 required', () => {
    const result = verifyExtractionCoverage({ task: 'definition-extraction', candidates: [stop], baseline,
      submission: { ...submission, coverage: [{ id: 'stopCode', label: '站码', kind: 'field', isOptional: true, sampleOmissions: 15 }] } });
    expect(result.anomalies.map((a) => a.code)).toContain('fieldShouldBeOptional');
    const corrected = candidate('停靠站点', [{ name: 'code', type: 'text' }]);
    const after = verifyExtractionCoverage({ task: 'definition-extraction', candidates: [corrected], baseline,
      submission: { ...submission, coverage: [{ id: 'stopCode', label: '站码', kind: 'field', sampleOmissions: 15 }] } });
    expect(after.status).toBe('needsReview'); expect(after.passed).toBe(false);
    expect(after.unknownItems).toContain('paymentMethods');
  });
  it('禁止常量的说明不会反向授权；只能使用宿主已核准授权', () => {
    const claim: SubmittedOutcome = { ...submission, coverage: [{ id: 'paymentMethods', label: '付款方式', kind: 'constant', justification: '我确认' }] };
    const first = verifyExtractionCoverage({ task: 'definition-extraction', candidates: [], baseline, submission: claim, briefText: '付款方式不得作为固定常量。' });
    expect(first.anomalies.map((a) => a.code)).toContain('unjustifiedConstant');
    const approved = verifyExtractionCoverage({ task: 'definition-extraction', candidates: [], baseline: { ...baseline, allowedConstantsInBrief: ['paymentMethods'] }, submission: claim });
    expect(approved.anomalies.map((a) => a.code)).not.toContain('unjustifiedConstant');
  });
  it('凭空覆盖 ID 与不存在字段不能产生已覆盖结果', () => {
    const report = verifyExtractionCoverage({ task: 'definition-extraction', candidates: [], baseline,
      submission: { ...submission, coverage: [{ id: 'stopCode', label: '站码', kind: 'field', path: 'doesNotExist' }] } });
    expect(report.missingItems).toContain('stopCode'); expect(report.coveredItems).not.toContain('stopCode'); expect(report.passed).toBe(false);
  });
  it('已知值遗漏、错值和未知值编造不能通过一句 notes 绕过', () => {
    const facts: BusinessContentBaseline = { name: '原失败场景事实', items: [{ id: 'minutesFromStart', label: '累计分钟', values: [
      { path: 'stops[1].minutesFromStart', value: 0 }, { path: 'stops[2].minutesFromStart', unknown: true }, { path: 'stops[6].minutesFromStart', value: 24 },
    ] }] };
    const dataset = { path: 'candidates/data.json', kind: 'dataset' as const, problems: [], document: { dataset: { staticSchema: { name: '线路牌', version: 1 } }, data: { stops: [{ minutesFromStart: 0 }, { minutesFromStart: 999 }, {}, {}, {}, { minutesFromStart: 23 }] } } };
    const report = verifyExtractionCoverage({ task: 'dataset-extraction', candidates: [dataset], baseline: facts,
      submission: { ...submission, coverage: [{ id: 'minutesFromStart', label: '累计分钟', kind: 'field', notes: '已核对，全部正确' }] } });
    expect(report.anomalies.map((a) => a.code)).toEqual(['fabricatedUnknownValues', 'valueMismatch']);
    dataset.document.data.stops = [{ minutesFromStart: 0 }, {}, {}, {}, {}, { minutesFromStart: 24 }];
    expect(verifyExtractionCoverage({ task: 'dataset-extraction', candidates: [dataset], baseline: facts }).status).toBe('needsReview');
    dataset.document.data.stops = [{ minutesFromStart: 0 }, {}, {}, {}, {}, {}];
    expect(verifyExtractionCoverage({ task: 'dataset-extraction', candidates: [dataset], baseline: facts }).anomalies.map((a) => a.code)).toContain('missingBusinessCoverage');
  });
  it('实际 outcome 核对接入可信基准，而非只测内部判据', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rw-coverage-'));
    try {
      await mkdir(join(dir, 'candidates'));
      await writeFile(join(dir, stop.path), JSON.stringify(stop.document));
      await writeFile(join(dir, 'outcome.json'), JSON.stringify(submission));
      const workspace = { staticSchemas: [], templates: [], datasets: [], problems: [], resources: createMemoryResourceRepository([]) };
      const result = await checkAgentOutcome({ task: 'definition-extraction', agentDir: dir, workspace, context: { contentBaseline: baseline } });
      expect(result.verdict).toBe('unqualified'); expect(result.assessment.coverage?.anomalies.map((a) => a.code)).toContain('fieldShouldBeOptional');
      const noFacts = await checkAgentOutcome({ task: 'definition-extraction', agentDir: dir, workspace });
      expect(noFacts.verdict).toBe('qualified'); expect(noFacts.assessment.coverage?.status).toBe('notChecked');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
