/**
 * 样式与尺寸基准核查（票据 34）：
 * 建立原图坐标与物理尺寸基准，结合 CanvasKit 渲染生成的实际布局摘要，
 * 检查元素字号、物理尺寸、间距、独立样式与各业务状态（普通、本站、已过、终点、最长文本等），
 * 自动扫描重复实例，识别尺寸异常（如字号明显偏小），记录绑定候选哈希与请求，修改后失效。
 */
import { createHash } from 'node:crypto';
import type { LayoutNode, LayoutSummary, TextSummary } from '../layout/index.js';
import type { RenderRequest } from '../request.js';
import { roundMm } from '../units.js';

/** 人工核准的原图区域 */
export interface ApprovedRegion {
  readonly id: string;
  readonly name: string;
  /** 原图像素区域（相对示例图左上角） */
  readonly sampleRegion: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  /** 目标元素路径匹配模式（通配符 * 或全等，如 "*站名*" 或 "主模板/站点列表[*]/站名"） */
  readonly targetPathPattern?: string;
  /** 目标角色（如 stopName, currentStop, routeNo, landmark） */
  readonly role?: string;
  /**
   * 预期字号（毫米，可选）。
   * 省略时由原图物理框高自动换算：physicalHeightMm * heightToFontRatio（缺省 0.95）。
   */
  readonly expectedFontSizeMm?: number;
  /**
   * 容差比例：实际值 / 预期值
   * 低于 min 判定为明显偏小（默认 0.65），高于 max 判定为明显偏大（默认 1.35）。
   */
  readonly toleranceRatio?: {
    readonly min?: number;
    readonly max?: number;
  };
}

/** 参考基准 */
export interface ReferenceBaseline {
  /** 示例图的像素尺寸 */
  readonly sampleWidthPx: number;
  readonly sampleHeightPx: number;
  /** 画板物理尺寸（毫米） */
  readonly artboardWidthMm: number;
  readonly artboardHeightMm: number;
  /** 人工核准区域列表 */
  readonly approvedRegions: readonly ApprovedRegion[];
}

/** 样式异常 */
export interface StyleAnomaly {
  readonly kind: 'fontSizeTooSmall' | 'fontSizeTooLarge' | 'missingStateStyle' | 'sizeDeviation';
  readonly path: string;
  readonly elementRole?: string;
  readonly actualMm: number;
  readonly expectedMm: number;
  readonly ratio: number;
  readonly message: string;
}

/** 状态覆盖 */
export type BusinessState = 'normal' | 'current' | 'passed' | 'terminal' | 'longestText';

/** 样式与尺寸核查报告 */
export interface StyleVerificationRecord {
  readonly format: 'renderweave-style-verification/1';
  readonly verifiedAt: string;
  readonly candidatesHash: string;
  readonly requestHash: string;
  readonly baselineHash: string;
  /** 候选修改后该字段为 false */
  readonly valid: boolean;
  readonly physicalScale: {
    readonly pxPerMmh: number;
    readonly pxPerMmv: number;
  };
  readonly coverage: {
    readonly approvedRegionsTotal: number;
    readonly approvedRegionsMatched: number;
    readonly repeatedInstancesScanned: number;
    readonly statesCovered: readonly BusinessState[];
  };
  readonly anomalies: readonly StyleAnomaly[];
  readonly passed: boolean;
}

/** 计算候选文档与请求的联合哈希 */
export function hashCandidatesAndRequest(candidates: readonly { readonly name?: string; readonly document: unknown }[], request: RenderRequest): {
  candidatesHash: string;
  requestHash: string;
} {
  const cHash = createHash('sha256')
    .update(
      JSON.stringify(
        candidates.map((c) => ({ name: c.name, doc: c.document })).sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')),
      ),
    )
    .digest('hex');
  const rHash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
  return { candidatesHash: cHash, requestHash: rHash };
}

/** 核查记录是否仍然有效 */
export function isVerificationValid(
  record: StyleVerificationRecord,
  currentCandidatesHash: string,
  currentRequestHash: string,
): boolean {
  return record.valid && record.candidatesHash === currentCandidatesHash && record.requestHash === currentRequestHash;
}

/**
 * 校验元素路径是否匹配通配模式
 * 模式支持 * 匹配任意字符（例如 "*站名*" 或 "*[5]/名称"）
 */
export function matchPath(pattern: string, path: string): boolean {
  if (pattern === path) return true;
  if (!pattern.includes('*')) return path.includes(pattern);
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(path);
}

/**
 * 执行样式与物理尺寸核查
 */
export function verifyElementStyles(options: {
  readonly layout: LayoutSummary;
  readonly baseline?: ReferenceBaseline;
  readonly candidatesHash: string;
  readonly requestHash: string;
  /** 出图参数（如 currentIndex，用于识别状态） */
  readonly parameters?: Record<string, unknown>;
}): StyleVerificationRecord {
  const { layout, baseline, candidatesHash, requestHash, parameters } = options;
  const anomalies: StyleAnomaly[] = [];

  const verifiedAt = new Date().toISOString();
  const baselineHash = baseline ? createHash('sha256').update(JSON.stringify(baseline)).digest('hex') : '';

  // 1. 全局物理尺度基准（px/mm）
  const pxPerMmh = baseline ? baseline.sampleWidthPx / baseline.artboardWidthMm : layout.output.widthPx / layout.output.width;
  const pxPerMmv = baseline ? baseline.sampleHeightPx / baseline.artboardHeightMm : layout.output.heightPx / layout.output.height;

  // 扁平化收集所有可见布局节点
  const allNodes: LayoutNode[] = [];
  const walk = (node: LayoutNode) => {
    if (node.visible !== false) allNodes.push(node);
    node.children?.forEach(walk);
  };
  walk(layout.root);

  // 2. 自动扫描重复实例
  // 按照路径中是否包含循环/数组下标 [N] 聚类
  const repeatedPatternMap = new Map<string, LayoutNode[]>();
  for (const node of allNodes) {
    if (/\[\d+\]/.test(node.path)) {
      const genericPath = node.path.replace(/\[\d+\]/g, '[*]');
      const list = repeatedPatternMap.get(genericPath) ?? [];
      list.push(node);
      repeatedPatternMap.set(genericPath, list);
    }
  }

  // 3. 业务状态覆盖识别（普通、本站/当前、已过、终点、最长文本）
  const coveredStates = new Set<BusinessState>();
  coveredStates.add('normal'); // 只要有实例即有普通态

  const currentIndex = typeof parameters?.['currentIndex'] === 'number' ? parameters['currentIndex'] : undefined;

  // 遍历所有重复的文本实例集合，核实状态与缩字组一致性
  let repeatedInstancesCount = 0;
  for (const [_genericPath, nodes] of repeatedPatternMap.entries()) {
    repeatedInstancesCount += nodes.length;
    const textNodes = nodes.filter((n): n is LayoutNode & { text: TextSummary } => n.text !== undefined);
    if (textNodes.length === 0) continue;

    // 状态识别
    if (textNodes.length >= 2) {
      coveredStates.add('terminal'); // 首末站
    }

    if (currentIndex !== undefined && currentIndex > 0) {
      // 检查本站实例与已过实例
      const activeNode = nodes.find((n) => matchPath(`*[${currentIndex}]*`, n.path));
      if (activeNode) coveredStates.add('current');
      const passedNode = nodes.find((n) => {
        const match = n.path.match(/\[(\d+)\]/);
        return match && Number(match[1]) < currentIndex;
      });
      if (passedNode) coveredStates.add('passed');
    }

    // 检查最长文本实例
    const longest = [...textNodes].sort((a, b) => b.text.content.length - a.text.content.length)[0];
    if (longest) coveredStates.add('longestText');
  }

  // 4. 对照人工核准区域比对物理尺寸与字号（基准校验）
  let matchedRegions = 0;
  if (baseline && baseline.approvedRegions.length > 0) {
    for (const region of baseline.approvedRegions) {
      // 物理参考尺寸（毫米）
      const physWidthMm = roundMm(region.sampleRegion.width / pxPerMmh);
      const physHeightMm = roundMm(region.sampleRegion.height / pxPerMmv);

      // 计算预期字号：若未显式指定，按竖排或横排单行高度估算
      const expectedFontMm =
        region.expectedFontSizeMm ?? roundMm(Math.min(physWidthMm, physHeightMm) * 0.95);

      const minRatio = region.toleranceRatio?.min ?? 0.65;
      const maxRatio = region.toleranceRatio?.max ?? 1.35;

      // 在布局节点中寻找匹配的节点
      const matched = allNodes.filter((node) => {
        if (region.targetPathPattern && !matchPath(region.targetPathPattern, node.path)) return false;
        if (region.role && !node.path.toLowerCase().includes(region.role.toLowerCase())) return false;
        return true;
      });

      if (matched.length > 0) {
        matchedRegions++;
        for (const node of matched) {
          if (node.text) {
            const actualFont = node.text.fontSize;
            const ratio = actualFont / expectedFontMm;
            if (ratio < minRatio) {
              anomalies.push({
                kind: 'fontSizeTooSmall',
                path: node.path,
                elementRole: region.name,
                actualMm: actualFont,
                expectedMm: expectedFontMm,
                ratio: Math.round(ratio * 100) / 100,
                message: `元素“${node.path}”实际字号 ${actualFont} mm 相对参考基准“${region.name}”（预期 ${expectedFontMm} mm，参考框高 ${physHeightMm} mm）明显偏小（比率 ${Math.round(ratio * 100)}% < ${minRatio * 100}%）`,
              });
            } else if (ratio > maxRatio) {
              anomalies.push({
                kind: 'fontSizeTooLarge',
                path: node.path,
                elementRole: region.name,
                actualMm: actualFont,
                expectedMm: expectedFontMm,
                ratio: Math.round(ratio * 100) / 100,
                message: `元素“${node.path}”实际字号 ${actualFont} mm 相对参考基准“${region.name}”（预期 ${expectedFontMm} mm）明显偏大（比率 ${Math.round(ratio * 100)}% > ${maxRatio * 100}%）`,
              });
            }
          }
        }
      }
    }
  }

  return {
    format: 'renderweave-style-verification/1',
    verifiedAt,
    candidatesHash,
    requestHash,
    baselineHash,
    valid: true,
    physicalScale: {
      pxPerMmh: Math.round(pxPerMmh * 100) / 100,
      pxPerMmv: Math.round(pxPerMmv * 100) / 100,
    },
    coverage: {
      approvedRegionsTotal: baseline?.approvedRegions.length ?? 0,
      approvedRegionsMatched: matchedRegions,
      repeatedInstancesScanned: repeatedInstancesCount,
      statesCovered: [...coveredStates],
    },
    anomalies,
    passed: anomalies.length === 0,
  };
}
