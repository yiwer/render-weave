import { describe, expect, it } from 'vitest';
import {
  checkAgentOutcome,
  scoreExtractionCoverage,
  verifyExtractionCoverage,
  createMemoryResourceRepository,
  type SubmittedOutcome,
  type BusinessContentBaseline,
} from '../src/index.js';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('票据 33：提取成果保留全部业务信息并正确表达未知值', () => {
  async function withTempAgentDir<T>(fn: (agentDir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'rw-test-coverage-'));
    try {
      await mkdir(join(dir, 'candidates'), { recursive: true });
      return await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  const emptyWorkspace = {
    staticSchemas: [],
    templates: [],
    datasets: [],
    problems: [],
    resources: createMemoryResourceRepository([]),
  };

  // 阿拉伯文线路牌基准测试模型定义
  const ROUTE_SCHEMA_R1B = {
    dslVersion: 'renderweave-schema/1',
    name: '线路牌',
    version: 1,
    displayName: '线路牌',
    fields: [
      { name: 'routeNo', displayName: '线路号', type: 'text' },
      { name: 'stops', displayName: '停靠站点', type: 'list', items: { type: 'ref', ref: { name: '停靠站点', version: 1 } } },
      { name: 'terminal', displayName: '终点站', type: 'text' }, // 错误：重复建立终点字段
      { name: 'fare', displayName: '票价', type: 'number' },
      { name: 'qrcode', displayName: '二维码占位', type: 'text' },
    ],
  };

  const STOP_SCHEMA_R1B = {
    dslVersion: 'renderweave-schema/1',
    name: '停靠站点',
    version: 1,
    displayName: '停靠站点',
    fields: [
      { name: 'name', displayName: '站名', type: 'text' },
      // 错误：code 设为必填 (required: true)，而 16 站中 15 站缺编号
      { name: 'code', displayName: '站点编号', type: 'text', constraints: { required: true } },
    ],
  };

  const ROUTE_SCHEMA_R1C = {
    dslVersion: 'renderweave-schema/1',
    name: '线路牌',
    version: 1,
    displayName: '线路牌',
    fields: [
      { name: 'routeNo', displayName: '线路号', type: 'text' },
      { name: 'stops', displayName: '停靠站点', type: 'list', items: { type: 'ref', ref: { name: '停靠站点', version: 1 } } },
      // 正确：无重复 terminal 字段，终点由 stops 末项派生
      { name: 'fare', displayName: '票价', type: 'number' },
      { name: 'peakHours', displayName: '高峰时段', type: 'text' }, // 正确：建为可选字段
      { name: 'paymentMethods', displayName: '付款方式', type: 'text' }, // 正确：建为可选字段
      { name: 'transferValidity', displayName: '换乘有效期', type: 'text' }, // 正确：建为可选字段
      { name: 'qrcode', displayName: '二维码占位', type: 'text' },
    ],
  };

  const STOP_SCHEMA_R1C = {
    dslVersion: 'renderweave-schema/1',
    name: '停靠站点',
    version: 1,
    displayName: '停靠站点',
    fields: [
      { name: 'name', displayName: '站名', type: 'text' },
      // 正确：code 设为可选 (required: false 或不写)
      { name: 'code', displayName: '站点编号', type: 'text', constraints: { required: false } },
      { name: 'minutesFromStart', displayName: '到站累计分钟', type: 'number' },
    ],
  };

  it('条目 1 & 2：数据定义首次提取（r1b）精准拦截必填错误、无依据常量与重复终点', () => {
    // 首次数据定义提取（r1b）：code 设为必填，未说明 15 个已知缺编号；notes 自行将高峰付款等归为全市固定常量；重复定义终点；二维码声称可由站码推出
    const submissionR1b: SubmittedOutcome = {
      candidates: ['candidates/schema-route.json', 'candidates/schema-stop.json'],
      pending: [],
      notes: '关键取舍：高峰时段、付款方式与换乘有效期属于全市统一规定，直接写死在模板里；二维码内容可由站码推出；剩余差异：后续需补齐缺失的站码编号。',
    };

    const result = verifyExtractionCoverage({
      task: 'definition-extraction',
      candidates: [
        { path: 'candidates/schema-route.json', kind: 'definition', name: '线路牌', problems: [], document: ROUTE_SCHEMA_R1B },
        { path: 'candidates/schema-stop.json', kind: 'definition', name: '停靠站点', problems: [], document: STOP_SCHEMA_R1B },
      ],
      submission: submissionR1b,
    });

    expect(result.passed).toBe(false);
    expect(result.score.passed).toBe(false);
    expect(result.score.totalScore).toBeLessThan(60);

    const codes = result.anomalies.map((a) => a.code);
    expect(codes).toContain('fieldShouldBeOptional');
    expect(codes).toContain('omissionWithoutExplanation');
    expect(codes).toContain('unjustifiedConstant');
    expect(codes).toContain('duplicateTerminalField');
    expect(codes).toContain('fabricatedQrContent');
  });

  it('条目 1 & 2：反馈后数据定义（r1c）站码可选、说明缺编号、有时段字段且终点由末站派生，核查通过', () => {
    const submissionR1c: SubmittedOutcome = {
      candidates: ['candidates/schema-route.json', 'candidates/schema-stop.json'],
      pending: [
        {
          file: 'candidates/schema-stop.json',
          path: 'code',
          reason: 'unreadable',
          note: '示例图中除当前站外，其余 15 处停靠站点缺少编号，设为可选并待客户提供完整线路编号表',
        },
      ],
      coverage: [
        { id: 'routeNo', label: '线路号', kind: 'field', path: 'routeNo' },
        { id: 'stops', label: '停靠站点列表', kind: 'field', path: 'stops' },
        { id: 'stopName', label: '站点名称', kind: 'field', path: 'name' },
        { id: 'stopCode', label: '站点编号', kind: 'field', path: 'code', isOptional: true, sampleOmissions: 15 },
        { id: 'minutesFromStart', label: '到站累计分钟', kind: 'field', path: 'minutesFromStart', isOptional: true },
        { id: 'peakHours', label: '高峰时段', kind: 'field', path: 'peakHours', isOptional: true },
        { id: 'paymentMethods', label: '付款方式', kind: 'field', path: 'paymentMethods', isOptional: true },
        { id: 'transferValidity', label: '换乘有效期', kind: 'field', path: 'transferValidity', isOptional: true },
        { id: 'terminal', label: '终点站', kind: 'derived', derivedFrom: ['stops'], logic: '由停靠站点列表最后一项派生' },
        { id: 'qrcode', label: '二维码占位', kind: 'field', path: 'qrcode', notes: '图上仅为占位符' },
      ],
      notes: '已按反馈修改：站点编号设为可选，说明了 15 个已知缺编号；高峰时段、付款方式与换乘有效期建为可选字段；终点站由末站派生，删除独立字段；二维码保持占位。',
    };

    const result = verifyExtractionCoverage({
      task: 'definition-extraction',
      candidates: [
        { path: 'candidates/schema-route.json', kind: 'definition', name: '线路牌', problems: [], document: ROUTE_SCHEMA_R1C },
        { path: 'candidates/schema-stop.json', kind: 'definition', name: '停靠站点', problems: [], document: STOP_SCHEMA_R1C },
      ],
      submission: submissionR1c,
    });

    expect(result.passed).toBe(true);
    expect(result.anomalies).toHaveLength(0);
    expect(result.score.totalScore).toBe(100);
    expect(result.score.passed).toBe(true);
  });

  it('条目 3：数据集累计分钟整块遗漏被覆盖检查发现；未知的第 2–5 站编造被拦截', () => {
    // 首次数据集提取（r2）：所有 minutesFromStart 留空，pending 为空，整块信息丢失
    const stopsAllEmpty = Array.from({ length: 16 }, (_, i) => ({
      name: `站 ${i + 1}`,
      code: i === 5 ? '1206' : undefined,
      // minutesFromStart 全部缺省，未填
    }));

    const datasetR2 = {
      dataset: { id: 'route-12-dir1', staticSchema: { name: '线路牌', version: 1 } },
      data: { routeNo: '12', stops: stopsAllEmpty },
    };

    const resultEmpty = verifyExtractionCoverage({
      task: 'dataset-extraction',
      definitions: [STOP_SCHEMA_R1C],
      candidates: [
        { path: 'candidates/dataset.json', kind: 'dataset', name: 'route-12-dir1', problems: [], document: datasetR2 },
      ],
      submission: {
        candidates: ['candidates/dataset.json'],
        pending: [],
        notes: '说明：图上没有累计分钟信息。',
      },
    });

    expect(resultEmpty.passed).toBe(false);
    expect(resultEmpty.anomalies.map((a) => a.code)).toContain('missingBusinessCoverage');

    // 编造未知值测试：第 2–5 站编造了数字
    const stopsFabricated = Array.from({ length: 16 }, (_, i) => ({
      name: `站 ${i + 1}`,
      code: i === 5 ? '1206' : undefined,
      minutesFromStart: i === 0 ? 0 : i <= 4 ? i * 5 : 24 + (i - 5) * 3, // 错误：第 2–5 站 (下标 1..4) 编造了 5, 10, 15, 20
    }));

    const datasetFabricated = {
      dataset: { id: 'route-12-dir1', staticSchema: { name: '线路牌', version: 1 } },
      data: { routeNo: '12', stops: stopsFabricated },
    };

    const resultFabricated = verifyExtractionCoverage({
      task: 'dataset-extraction',
      definitions: [STOP_SCHEMA_R1C],
      candidates: [
        { path: 'candidates/dataset.json', kind: 'dataset', name: 'route-12-dir1', problems: [], document: datasetFabricated },
      ],
      submission: {
        candidates: ['candidates/dataset.json'],
        pending: [],
        notes: '推断了全部站点的分钟。',
      },
    });

    expect(resultFabricated.passed).toBe(false);
    expect(resultFabricated.anomalies.map((a) => a.code)).toContain('fabricatedUnknownValues');
  });

  it('条目 3：反馈后数据集（r2b）未知的第 2–5 站保持缺省，推导值附带依据，核查通过', () => {
    // 反馈后数据集提取（r2b）：
    // 始发站 0；第 2–5 站保持缺省；当前站 24 (55-31)；后续站 27, 30, 32... 均有推导依据
    const stopsR2b = Array.from({ length: 16 }, (_, i) => ({
      name: `站 ${i + 1}`,
      code: i === 5 ? '1206' : undefined,
      minutesFromStart: i === 0 ? 0 : (i >= 1 && i <= 4) ? undefined : i === 5 ? 24 : 24 + (i - 5) * 3,
    }));

    const datasetR2b = {
      dataset: { id: 'route-12-dir1', staticSchema: { name: '线路牌', version: 1 } },
      data: { routeNo: '12', stops: stopsR2b },
    };

    const pendingInferred = [
      {
        file: 'candidates/dataset.json',
        path: 'stops[6].minutesFromStart',
        candidate: 24,
        reason: 'inferred' as const,
        note: '当前停靠站距末站还有 31 分钟，总程 55 分钟，由此推导 55-31=24 分钟',
      },
      ...[6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map((idx) => ({
        file: 'candidates/dataset.json',
        path: `stops[${idx + 1}].minutesFromStart`,
        candidate: 24 + (idx - 5) * 3,
        reason: 'inferred' as const,
        note: `后续站由当前站 24 分钟累加分段到站分钟得出`,
      })),
    ];

    const result = verifyExtractionCoverage({
      task: 'dataset-extraction',
      definitions: [STOP_SCHEMA_R1C],
      candidates: [
        { path: 'candidates/dataset.json', kind: 'dataset', name: 'route-12-dir1', problems: [], document: datasetR2b },
      ],
      submission: {
        candidates: ['candidates/dataset.json'],
        pending: pendingInferred,
        notes: '已按反馈修改：第 2–5 站因未提供分段分钟保持缺省；始发站设为 0；本站推导为 24 分钟；后续站点按站间间隔累加并记录计算依据。',
      },
    });

    expect(result.passed).toBe(true);
    expect(result.anomalies).toHaveLength(0);
    expect(result.score.totalScore).toBe(100);
    expect(result.score.passed).toBe(true);
  });

  it('条目 4：覆盖记录区分字段、派生、参数、固定标签与待确认；Agent 自述不能替代独立事实核对', () => {
    // Agent 在 notes 中声称“全部信息已提取完毕，高峰期和付款属于全市常量无须建字段”，
    // 但独立基准核对识别出该自述不成立，并报错拦截
    const customBaseline: BusinessContentBaseline = {
      name: 'custom-sign',
      items: [
        { id: 'routeNo', label: '线路号', expectedKind: 'field' },
        { id: 'peakHours', label: '高峰时段', expectedKind: 'field', allowConstantWithoutBrief: false },
      ],
    };

    const result = verifyExtractionCoverage({
      task: 'definition-extraction',
      baseline: customBaseline,
      candidates: [
        {
          path: 'candidates/schema.json',
          kind: 'definition',
          name: '简单线路',
          problems: [],
          document: {
            dslVersion: 'renderweave-schema/1',
            name: '简单线路',
            displayName: '简单线路',
            fields: [{ name: 'routeNo', displayName: '线路号', type: 'text' }],
          },
        },
      ],
      submission: {
        candidates: ['candidates/schema.json'],
        pending: [],
        notes: '高峰时段是全市统一定义的，完全不需要作为数据字段！',
      },
    });

    expect(result.passed).toBe(false);
    expect(result.anomalies.length).toBeGreaterThan(0);
    expect(result.anomalies[0]!.code).toBe('unjustifiedConstant');
    expect(result.anomalies[0]!.message).toContain('项目说明未授权其为全市统一常量');
  });

  it('回归：图上没有出现的业务项不必建字段，不能因缺席而判为固定常量', () => {
    // M402 一类线路牌不展示高峰时段、付款方式与换乘有效期，数据定义里没有这些字段是正常的；
    // 只有 Agent 明确声称它们是全市统一常量时才算无依据。
    const result = verifyExtractionCoverage({
      task: 'definition-extraction',
      candidates: [
        {
          path: 'candidates/schema-route.json',
          kind: 'definition',
          name: '公交线路牌',
          problems: [],
          document: {
            dslVersion: 'renderweave-schema/1',
            name: '公交线路牌',
            displayName: '公交线路牌',
            fields: [
              { name: 'routeNo', displayName: '线路号', type: 'text' },
              { name: 'stations', displayName: '站点列表', type: 'list', items: { type: 'ref', ref: { name: '站点', version: 1 } } },
            ],
          },
        },
        {
          path: 'candidates/schema-stop.json',
          kind: 'definition',
          name: '站点',
          problems: [],
          document: {
            dslVersion: 'renderweave-schema/1',
            name: '站点',
            displayName: '站点',
            fields: [{ name: 'name', displayName: '站名', type: 'text' }],
          },
        },
      ],
      submission: { candidates: ['candidates/schema-route.json', 'candidates/schema-stop.json'], pending: [], notes: '按图上内容提取。' },
    });

    expect(result.passed).toBe(true);
    expect(result.anomalies).toEqual([]);
  });

  it('回归：数据定义没有到站分钟时，数据集不因缺少该列被判为信息丢失', () => {
    const result = verifyExtractionCoverage({
      task: 'dataset-extraction',
      definitions: [{ dslVersion: 'renderweave-schema/1', name: '站点', displayName: '站点', fields: [{ name: 'name', displayName: '站名', type: 'text' }] }],
      candidates: [
        {
          path: 'candidates/dataset.json',
          kind: 'dataset',
          name: 'route-366',
          problems: [],
          document: {
            dataset: { id: 'route-366', staticSchema: { name: '公交线路牌', version: 1 } },
            data: { routeNo: '366', stops: [{ name: '甲站' }, { name: '乙站' }] },
          },
        },
      ],
      submission: { candidates: ['candidates/dataset.json'], pending: [], notes: '366 线路牌不展示到站分钟。' },
    });

    expect(result.passed).toBe(true);
    expect(result.anomalies).toEqual([]);
  });

  it('条目 5：首次结果与反馈结果分别评分，通过 checkAgentOutcome 完整校验链路验证', async () => {
    await withTempAgentDir(async (agentDir) => {
      // 写入 r1b (首次失败结果)
      await writeFile(join(agentDir, 'candidates', 'schema-route.json'), JSON.stringify(ROUTE_SCHEMA_R1B));
      await writeFile(join(agentDir, 'candidates', 'schema-stop.json'), JSON.stringify(STOP_SCHEMA_R1B));
      await writeFile(
        join(agentDir, 'outcome.json'),
        JSON.stringify({
          candidates: ['candidates/schema-route.json', 'candidates/schema-stop.json'],
          pending: [],
          notes: '首次结果：高峰时段、付款方式为全市统一规定写死在模板；终点建立独立字段；二维码由站码推出。',
        }),
      );

      const checkR1b = await checkAgentOutcome({
        task: 'definition-extraction',
        agentDir,
        workspace: emptyWorkspace,
      });

      // 首次结果：判定为 unqualified，score 扣分
      expect(checkR1b.verdict).toBe('unqualified');
      expect(checkR1b.assessment.coverage).toBeDefined();
      expect(checkR1b.assessment.coverage!.passed).toBe(false);
      expect(checkR1b.assessment.coverage!.score).toBeLessThan(60);
      expect(checkR1b.problems.some((p) => p.message.includes('站码字段'))).toBe(true);

      const scoreR1b = scoreExtractionCoverage(checkR1b.coverageVerification!);
      expect(scoreR1b.passed).toBe(false);

      // 改写为 r1c (反馈后成功结果)
      await writeFile(join(agentDir, 'candidates', 'schema-route.json'), JSON.stringify(ROUTE_SCHEMA_R1C));
      await writeFile(join(agentDir, 'candidates', 'schema-stop.json'), JSON.stringify(STOP_SCHEMA_R1C));
      await writeFile(
        join(agentDir, 'outcome.json'),
        JSON.stringify({
          candidates: ['candidates/schema-route.json', 'candidates/schema-stop.json'],
          pending: [
            {
              file: 'candidates/schema-stop.json',
              path: 'code',
              reason: 'unreadable',
              note: '示例图中 15 处停靠站点缺少编号，设为可选',
            },
          ],
          coverage: [
            { id: 'routeNo', label: '线路号', kind: 'field', path: 'routeNo' },
            { id: 'stops', label: '停靠站点列表', kind: 'field', path: 'stops' },
            { id: 'stopName', label: '站点名称', kind: 'field', path: 'name' },
            { id: 'stopCode', label: '站点编号', kind: 'field', path: 'code', isOptional: true, sampleOmissions: 15 },
            { id: 'minutesFromStart', label: '到站累计分钟', kind: 'field', path: 'minutesFromStart', isOptional: true },
            { id: 'peakHours', label: '高峰时段', kind: 'field', path: 'peakHours', isOptional: true },
            { id: 'paymentMethods', label: '付款方式', kind: 'field', path: 'paymentMethods', isOptional: true },
            { id: 'transferValidity', label: '换乘有效期', kind: 'field', path: 'transferValidity', isOptional: true },
            { id: 'terminal', label: '终点站', kind: 'derived', derivedFrom: ['stops'], logic: '由末站派生' },
            { id: 'qrcode', label: '二维码占位', kind: 'field', path: 'qrcode' },
          ],
          notes: '反馈后结果：站码可选并说明 15 处缺编号；业务时段建为可选字段；终点由末站派生；二维码占位。',
        }),
      );

      const checkR1c = await checkAgentOutcome({
        task: 'definition-extraction',
        agentDir,
        workspace: emptyWorkspace,
      });

      // 反馈结果：判定为 qualified，score 100 分
      expect(checkR1c.verdict).toBe('qualified');
      expect(checkR1c.assessment.coverage).toBeDefined();
      expect(checkR1c.assessment.coverage!.passed).toBe(true);
      expect(checkR1c.assessment.coverage!.score).toBe(100);
      expect(checkR1c.assessment.coverage!.anomalies).toHaveLength(0);

      const scoreR1c = scoreExtractionCoverage(checkR1c.coverageVerification!);
      expect(scoreR1c.passed).toBe(true);
      expect(scoreR1c.totalScore).toBe(100);

      // 分别评分对比
      expect(scoreR1c.totalScore).toBeGreaterThan(scoreR1b.totalScore + 40);
    });
  });
});
