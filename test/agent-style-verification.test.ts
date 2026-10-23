/**
 * 样式与尺寸基准核查测试（票据 34）：
 * - 本次 5.5 mm 站名能被标记为明显偏小；11 mm 是诊断对照，不能硬编码为所有项目的正确值；
 * - 自动检查所有重复实例；视觉核对每种独立样式及普通、本站、已过、终点、最长文本等状态；
 * - 核查记录绑定候选哈希与请求，候选修改后失效；返回覆盖情况与异常，而非只要求调用一次 inspect_layout；
 * - 允许字体替代与合理适配，不能把 OCR 框高直接当 fontSize；DPI 改变不应改变物理尺寸判据；
 * - 先用人工核准区域和现有布局摘要实施，不依赖 OCR 接入。
 */
import { describe, expect, it } from 'vitest';
import {
  hashCandidatesAndRequest,
  isVerificationValid,
  loadWorkspace,
  render,
  verifyElementStyles,
  checkAgentOutcome,
  type ReferenceBaseline,
  type RenderRequest,
} from '../src/index.js';
import { m402Dir, resourcesDir, singleTextDir } from './support/fixtures.js';

describe('票据 34：按参考基准核查所有独立样式和状态，自动扫描重复实例', () => {
  it('条目 1 & 5：本次 5.5 mm 站名能被标记为明显偏小；11 mm 通过；基准动态推算不硬编码', async () => {
    const workspace = await loadWorkspace({ dir: m402Dir, resourcesDir });

    // 模拟阿拉伯文站牌参考基准：
    // 示例图 3200 × 3600 px，画板 800 × 900 mm（4 px/mm）
    // 站名在原图上的像素高度为 44 px，对应物理高度 11 mm
    const baseline: ReferenceBaseline = {
      sampleWidthPx: 3200,
      sampleHeightPx: 3600,
      artboardWidthMm: 800,
      artboardHeightMm: 900,
      approvedRegions: [
        {
          id: 'stop-name-normal',
          name: '普通站名',
          sampleRegion: { x: 400, y: 1200, width: 200, height: 44 }, // 高度 44px -> 11mm
          targetPathPattern: '*站名*',
          toleranceRatio: { min: 0.65, max: 1.35 },
        },
      ],
    };

    // 构造 5.5 mm 的模板（原阿拉伯文复跑中的初始偏小候选）
    const smallTemplate = {
      dslVersion: 'renderweave-template/1',
      name: '测试站牌-偏小',
      base: { name: '线路牌', version: 1 },
      artboard: {
        sizeRange: { width: { min: 100, max: 1000 }, height: { min: 100, max: 1000 } },
        fill: '#FFFFFF',
        layout: { mode: 'free' },
        children: [
          {
            type: 'text',
            name: '普通站名',
            content: [{ text: '科技园站' }],
            font: 'res:font-hei-medium',
            fontSize: 5.5, // 5.5 mm
            color: '#000000',
            writingMode: 'vertical',
            place: { left: 100, top: 100, width: { fixed: 20 }, height: { fixed: 80 } },
          },
        ],
      },
    };

    const request: RenderRequest = {
      template: '测试站牌-偏小',
      dataset: { id: 'ds-m402-wanguocheng' },
      parameters: {},
      output: { width: 800, height: 900, dpi: 50, format: 'png' },
      mode: 'draft',
    };

    const customWorkspace = {
      ...workspace,
      templates: [...workspace.templates, { name: '测试站牌-偏小', document: smallTemplate, source: 'smallTemplate' }],
    };

    const smallResult = await render(customWorkspace, request);
    expect(smallResult.layout).toBeDefined();

    const { candidatesHash, requestHash } = hashCandidatesAndRequest(
      [{ name: '测试站牌-偏小', document: smallTemplate }],
      request,
    );

    const verificationSmall = verifyElementStyles({
      layout: smallResult.layout!,
      baseline,
      candidatesHash,
      requestHash,
    });

    // 验证：5.5 mm 相对预期 10.45~11 mm（比率约 50% < 65%），被明确标记为明显偏小
    expect(verificationSmall.passed).toBe(false);
    expect(verificationSmall.anomalies.length).toBeGreaterThan(0);
    const anomaly = verificationSmall.anomalies.find((a) => a.kind === 'fontSizeTooSmall');
    expect(anomaly).toBeDefined();
    expect(anomaly?.actualMm).toBe(5.5);
    expect(anomaly?.ratio).toBeLessThan(0.65);
    expect(anomaly?.message).toContain('明显偏小');

    // 对照组：改为 11 mm（诊断对照值）
    const fixedTemplate = {
      ...smallTemplate,
      name: '测试站牌-修正',
      artboard: {
        ...smallTemplate.artboard,
        children: [
          {
            ...smallTemplate.artboard.children[0]!,
            name: '普通站名',
            fontSize: 11, // 改为 11 mm
          },
        ],
      },
    };

    const fixedWorkspace = {
      ...workspace,
      templates: [...workspace.templates, { name: '测试站牌-修正', document: fixedTemplate, source: 'fixedTemplate' }],
    };
    const fixedRequest: RenderRequest = { ...request, template: '测试站牌-修正' };
    const fixedResult = await render(fixedWorkspace, fixedRequest);
    expect(fixedResult.layout).toBeDefined();

    const fixedHashes = hashCandidatesAndRequest(
      [{ name: '测试站牌-修正', document: fixedTemplate }],
      fixedRequest,
    );

    const verificationFixed = verifyElementStyles({
      layout: fixedResult.layout!,
      baseline,
      candidatesHash: fixedHashes.candidatesHash,
      requestHash: fixedHashes.requestHash,
    });

    // 验证：11 mm 在合理比例内（11/10.45 ≈ 1.05），通过
    expect(verificationFixed.passed).toBe(true);
    expect(verificationFixed.anomalies.filter((a) => a.kind === 'fontSizeTooSmall')).toEqual([]);

    // 证明不硬编码 11 mm：若更换参考基准（如标题区域高度 30 mm），11 mm 也会被判定为偏小
    const largeTitleBaseline: ReferenceBaseline = {
      ...baseline,
      approvedRegions: [
        {
          id: 'large-title',
          name: '大标题',
          sampleRegion: { x: 100, y: 100, width: 300, height: 120 }, // 120px -> 30mm
          targetPathPattern: '*普通站名*',
        },
      ],
    };
    const verificationDynamic = verifyElementStyles({
      layout: fixedResult.layout!,
      baseline: largeTitleBaseline,
      candidatesHash: fixedHashes.candidatesHash,
      requestHash: fixedHashes.requestHash,
    });
    // 此时 11 mm 相对 30 mm (11/28.5 ≈ 38%) 也会被标记为偏小，证明判据由基准驱动，非硬编码
    expect(verificationDynamic.passed).toBe(false);
    expect(verificationDynamic.anomalies[0]?.kind).toBe('fontSizeTooSmall');
  });

  it('条目 2：自动检查所有重复实例；视觉核对每种独立样式及普通、本站、已过、终点、最长文本状态', async () => {
    const workspace = await loadWorkspace({ dir: m402Dir, resourcesDir });
    const request: RenderRequest = {
      template: '标准线路单边',
      dataset: { id: 'ds-m402-wanguocheng' },
      parameters: { currentIndex: 5 },
      output: { width: 740, height: 165, dpi: 50, format: 'png' },
      mode: 'draft',
    };

    const result = await render(workspace, request);
    expect(result.layout).toBeDefined();

    const { candidatesHash, requestHash } = hashCandidatesAndRequest([], request);
    const verification = verifyElementStyles({
      layout: result.layout!,
      candidatesHash,
      requestHash,
      parameters: request.parameters,
    });

    // 验证自动扫描了重复实例
    expect(verification.coverage.repeatedInstancesScanned).toBeGreaterThanOrEqual(35);

    // 验证覆盖了各关键业务状态
    const states = verification.coverage.statesCovered;
    expect(states).toContain('normal');
    expect(states).toContain('current');
    expect(states).toContain('passed');
    expect(states).toContain('terminal');
    expect(states).toContain('longestText');
  });

  it('条目 3：核查记录绑定候选哈希与请求，候选修改后失效；返回覆盖情况与异常', async () => {
    const workspace = await loadWorkspace({ dir: singleTextDir, resourcesDir });
    const templateDoc = workspace.templates[0]!.document;
    const request: RenderRequest = {
      template: '问候牌',
      dataset: { id: 'ds-greeting' },
      parameters: {},
      output: { width: 160, height: 40, dpi: 50, format: 'png' },
      mode: 'draft',
    };

    const result = await render(workspace, request);
    const { candidatesHash, requestHash } = hashCandidatesAndRequest(
      [{ name: '问候牌', document: templateDoc }],
      request,
    );

    const record = verifyElementStyles({
      layout: result.layout!,
      candidatesHash,
      requestHash,
    });

    expect(record.format).toBe('renderweave-style-verification/1');
    expect(record.valid).toBe(true);
    expect(isVerificationValid(record, candidatesHash, requestHash)).toBe(true);

    // 候选修改（哈希变动）-> 核查记录失效
    const modifiedCandidatesHash = 'changed-hash-123456';
    expect(isVerificationValid(record, modifiedCandidatesHash, requestHash)).toBe(false);

    // 请求修改（哈希变动）-> 核查记录失效
    const modifiedRequestHash = 'changed-request-789012';
    expect(isVerificationValid(record, candidatesHash, modifiedRequestHash)).toBe(false);

    // 返回了完整的覆盖情况统计
    expect(record.coverage).toHaveProperty('repeatedInstancesScanned');
    expect(record.coverage).toHaveProperty('statesCovered');
    expect(record.anomalies).toBeInstanceOf(Array);
  });

  it('条目 4：DPI 改变不应改变物理尺寸判据；允许合理适配与容差', async () => {
    const workspace = await loadWorkspace({ dir: m402Dir, resourcesDir });

    const baseline: ReferenceBaseline = {
      sampleWidthPx: 3200,
      sampleHeightPx: 3600,
      artboardWidthMm: 800,
      artboardHeightMm: 900,
      approvedRegions: [
        {
          id: 'test-region',
          name: '站名字号基准',
          sampleRegion: { x: 100, y: 100, width: 200, height: 80 }, // 80px -> 20mm
          targetPathPattern: '*站名*',
          expectedFontSizeMm: 10,
        },
      ],
    };

    // 分别用 50 DPI 与 150 DPI 渲染同一模板
    const req50: RenderRequest = {
      template: '标准线路单边',
      dataset: { id: 'ds-m402-wanguocheng' },
      parameters: { currentIndex: 5 },
      output: { width: 740, height: 165, dpi: 50, format: 'png' },
      mode: 'draft',
    };
    const req150: RenderRequest = {
      ...req50,
      output: { ...req50.output, dpi: 150 },
    };

    const res50 = await render(workspace, req50);
    const res150 = await render(workspace, req150);

    const h50 = hashCandidatesAndRequest([], req50);
    const h150 = hashCandidatesAndRequest([], req150);

    const v50 = verifyElementStyles({
      layout: res50.layout!,
      baseline,
      candidatesHash: h50.candidatesHash,
      requestHash: h50.requestHash,
    });

    const v150 = verifyElementStyles({
      layout: res150.layout!,
      baseline,
      candidatesHash: h150.candidatesHash,
      requestHash: h150.requestHash,
    });

    // 验证物理尺寸判据保持绝对一致（DPI 不影响毫米判据）
    expect(v50.anomalies.length).toBe(v150.anomalies.length);
    if (v50.anomalies.length > 0) {
      expect(v50.anomalies[0]!.actualMm).toBe(v150.anomalies[0]!.actualMm);
      expect(v50.anomalies[0]!.expectedMm).toBe(v150.anomalies[0]!.expectedMm);
      expect(v50.anomalies[0]!.ratio).toBe(v150.anomalies[0]!.ratio);
    }
  });

  it('成果校验集成：checkAgentOutcome 在基准存在且字号偏小时包含样式核查异常提示', async () => {
    const workspace = await loadWorkspace({ dir: m402Dir, resourcesDir });

    const smallTemplate = {
      dslVersion: 'renderweave-template/1',
      name: '标准线路单边',
      base: { name: '线路牌', version: 1 },
      artboard: {
        sizeRange: { width: { min: 700, max: 800 }, height: { min: 150, max: 200 } },
        fill: '#FFFFFF',
        layout: { mode: 'free' },
        children: [
          {
            type: 'text',
            name: '站名',
            content: [{ text: '科技园' }],
            font: 'res:font-hei-medium',
            fontSize: 4, // 4 mm 远低于预期 10 mm
            color: '#000000',
            place: { left: 10, top: 10, width: { fixed: 50 }, height: { fixed: 20 } },
          },
        ],
      },
    };

    const baseline: ReferenceBaseline = {
      sampleWidthPx: 3200,
      sampleHeightPx: 3600,
      artboardWidthMm: 740,
      artboardHeightMm: 165,
      approvedRegions: [
        {
          id: 'stop-name',
          name: '站名',
          sampleRegion: { x: 100, y: 100, width: 200, height: 218 }, // ~10 mm
          targetPathPattern: '*站名*',
          expectedFontSizeMm: 10,
        },
      ],
    };

    const request = {
      template: '标准线路单边',
      dataset: { id: 'ds-m402-wanguocheng' },
      parameters: { currentIndex: 5 },
      output: { width: 740, height: 165, dpi: 50, format: 'png' },
    };

    // 内存中模拟 checkAgentOutcome
    const { tmpdir } = await import('node:os');
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
    const { join } = await import('node:path');

    const tempDir = await mkdtemp(join(tmpdir(), 'rw-outcome-style-'));
    try {
      await mkdir(join(tempDir, 'candidates'), { recursive: true });
      await writeFile(join(tempDir, 'candidates/template-main.json'), JSON.stringify(smallTemplate));
      await writeFile(
        join(tempDir, 'outcome.json'),
        JSON.stringify({
          candidates: ['candidates/template-main.json'],
          pending: [],
          notes: '测试偏小字号',
        }),
      );

      const check = await checkAgentOutcome({
        task: 'template-design',
        agentDir: tempDir,
        workspace,
        context: {
          request,
          baseline,
        },
      });

      // 验证样式核查已包含在 assessment 中
      expect(check.assessment.style).toBeDefined();
      expect(check.assessment.style?.passed).toBe(false);
      expect(check.styleVerification?.anomalies.length).toBeGreaterThan(0);
      expect(check.problems.some((p) => p.message.includes('明显偏小'))).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
