import bwip from 'bwip-js';
import { formatElementPath } from '../element-path.js';
import type { EvaluatedFragment } from '../evaluate.js';
import { ProblemCodes, severe, type Problem, type ProblemCode } from '../problems.js';
import { MAX_CODE128_LENGTH, type BarcodeModel, type TextElementModel } from '../template/model.js';
import type { FontStore } from '../text/fonts.js';
import { pxPerMm, roundMm } from '../units.js';
import { measureTextNode, recordText, type MeasuredLines } from './text.js';
import type { BarcodeSummary, Box, DrawOp } from './types.js';

const RETAIL = {
  'EAN-13': { encoder: 'ean13', length: 13, left: 11, right: 7 },
  'EAN-8': { encoder: 'ean8', length: 8, left: 7, right: 7 },
  'UPC-A': { encoder: 'upca', length: 12, left: 9, right: 9 },
} as const;

export function recordBarcode(
  model: BarcodeModel, fragments: readonly EvaluatedFragment[], box: Box, dpi: number,
  fonts: FontStore, ops: DrawOp[], problems: Problem[],
): BarcodeSummary | undefined {
  const fail = (code: ProblemCode, message: string): undefined => {
    problems.push(severe(code, { kind: 'element', path: formatElementPath(model.path) }, message));
    return undefined;
  };
  const retail = model.format === 'CODE128' ? undefined : RETAIL[model.format];
  if (retail) {
    if (model.content.length !== retail.length || /[^0-9]/u.test(model.content)) {
      return fail(ProblemCodes.barcodeContentInvalid, `${model.format} 必须是包含校验位的 ${retail.length} 位完整数字文本，不补位、不修剪、不转换`);
    }
    // 从完整编号右侧开始，校验位权重为 1，其左侧交替取 3、1；总和须为 10 的倍数。
    let sum = 0;
    for (let i = model.content.length - 1, weight = 1; i >= 0; i--, weight = 4 - weight) sum += Number(model.content[i]) * weight;
    if (sum % 10 !== 0) return fail(ProblemCodes.barcodeChecksumInvalid, `${model.format} 校验位不正确，请提供原始完整编号；不会自动修正`);
  } else {
    if (!model.content.length || /[^\x20-\x7E]/u.test(model.content)) {
      return fail(ProblemCodes.barcodeContentInvalid, 'CODE128 内容必须是非空的可打印 ASCII 文本（U+0020–U+007E），不自动转换或修剪');
    }
    if (model.content.length > MAX_CODE128_LENGTH) return fail(ProblemCodes.barcodeCapacityExceeded, `条形码内容超过产品上限 ${MAX_CODE128_LENGTH} 字符`);
  }
  const quietLeft = retail?.left ?? 10, quietRight = retail?.right ?? 10;
  if (!model.foreground.endsWith('FF') || !model.background.endsWith('FF') || model.foreground === model.background) {
    return fail(ProblemCodes.barcodeColorsInvalid, '条形码前景和背景必须是不透明且不同的颜色');
  }
  if (model.place.width?.kind === 'hug' || model.place.height?.kind === 'hug' || box.width <= 0 || box.height <= 0) {
    return fail(ProblemCodes.barcodeSizeInvalid, '条形码需要确定的宽高，不支持随内容尺寸');
  }
  // 禁止解析 ^NNN 与 ^FNC1 等库指令；它们都是用户原始编号中的普通字符。
  const encoded = bwip.raw({ bcid: retail?.encoder ?? 'code128', text: model.content, parse: false, parsefnc: false })[0];
  if (!encoded || !('sbs' in encoded)) throw new Error(`${model.format} 编码器未返回条空序列`);
  const widths = encoded.sbs;
  const modules = widths.reduce((sum, width) => sum + width, 0);
  const scale = pxPerMm(dpi);
  const left = Math.ceil(box.x * scale - 1e-7), top = Math.ceil(box.y * scale - 1e-7);
  const width = Math.floor((box.x + box.width) * scale + 1e-7) - left;
  const height = Math.floor((box.y + box.height) * scale + 1e-7) - top;
  const labelModel = labelOf(model);
  let measure: MeasuredLines | undefined;
  if (labelModel) {
    const measured = measureTextNode(labelModel, fragments, fonts);
    // 原字体不可用或替代后仍缺字时已有资源/缺字诊断，草稿也不画部分成功的条码。
    if ('unavailable' in measured || measured.runs.some(run => run.glyphs.some(glyph => glyph.id === 0))) return undefined;
    measure = encloseInk(measured);
    if (measure.width * scale > width + 1e-7) return fail(ProblemCodes.barcodeSizeInvalid, '条形码下方文字宽度不足；请扩大元素或减小 fontSize');
  }
  const labelHeight = measure ? Math.ceil(measure.height * scale) : 0;
  const gap = measure ? Math.ceil(scale) : 0; // 下方文字和码图保护区之间至少 1 mm。
  const minBarHeight = Math.ceil(5 * scale); // 产品下限 5 mm，不宣称为印刷标准。
  const moduleSizePx = Math.min(Math.floor(width / (modules + quietLeft + quietRight)), Math.floor((height - labelHeight - gap - minBarHeight) / 2));
  if (moduleSizePx < 2) {
    return fail(ProblemCodes.barcodeSizeInvalid, `条形码需 ${modules} 模块、左 ${quietLeft}、右 ${quietRight} 模块留白，模块至少 2 px、条高至少 5 mm，并为下方文字独立留空间；当前框 ${width} × ${height} px 不足`);
  }
  const moduleSize = moduleSizePx / scale;
  const barHeight = height - labelHeight - gap - 2 * moduleSizePx;
  const drawn: Box = { x: left / scale, y: top / scale, width: width / scale, height: height / scale };
  const symbol: Box = { x: (left + Math.floor((width - (modules + quietLeft + quietRight) * moduleSizePx) / 2) + quietLeft * moduleSizePx) / scale,
    y: (top + moduleSizePx) / scale, width: modules * moduleSize, height: barHeight / scale };
  const labelBox: Box = { x: drawn.x, y: (top + height - labelHeight) / scale, width: drawn.width, height: labelHeight / scale };
  const labelOps: DrawOp[] = [];
  const text = labelModel && measure ? recordText(labelModel, fragments, measure, labelBox, labelOps, problems) : undefined;
  ops.push({ op: 'barcode', drawn, symbol, moduleSize, widths, foreground: model.foreground, background: model.background }, ...labelOps);
  const boxes = { drawn: rounded(drawn), symbol: rounded(symbol), ...(text && { label: { box: rounded(labelBox), text } }) };
  return model.format === 'CODE128'
    ? { format: model.format, modules, moduleSizePx, quietZoneModules: 10, quietZoneMm: roundMm(10 * moduleSize), ...boxes }
    : { format: model.format, modules, moduleSizePx, quietZoneModules: { left: quietLeft, right: quietRight },
      quietZoneMm: { left: roundMm(quietLeft * moduleSize), right: roundMm(quietRight * moduleSize) }, ...boxes };
}

/** 下方文字复用普通文字的字形、缺字替代、绘制与摘要，不进入模板树或引入额外作用域。 */
function labelOf(model: BarcodeModel): TextElementModel | undefined {
  if (!model.showText || !model.font) return undefined;
  return { ...model, type: 'text', content: [{ kind: 'text', text: model.content, style: {} }], font: model.font,
    fontSize: model.fontSize, color: model.foreground, slant: 0, writingMode: 'horizontal', horizontalAlign: 'center', verticalAlign: 'center',
    padding: { top: 0, right: 0, bottom: 0, left: 0 },
    fit: { tightenSpacing: false, compressGlyphs: false, compressMin: 1, shrink: false, minFontSize: model.fontSize, minFontSizeSource: 'element', onFail: 'severe' } };
}

/** 字体墨迹可能越出行框或前进宽度，连同外伸部分一起预留，避免碰到码区或元素外。 */
function encloseInk(measure: MeasuredLines): MeasuredLines {
  let left = 0, right = measure.width, ascent = measure.ascent, descent = measure.descent;
  for (const run of measure.runs) {
    let x = run.x;
    for (const glyph of run.glyphs) {
      if (glyph.ink) {
        left = Math.min(left, x + glyph.ink.left);
        right = Math.max(right, x + glyph.ink.right);
        ascent = Math.max(ascent, -glyph.ink.top);
        descent = Math.max(descent, glyph.ink.bottom);
      }
      x += glyph.advance;
    }
  }
  return { ...measure, lead: -left, width: right - left, height: ascent + descent, ascent, descent };
}

function rounded(box: Box): Box {
  return { x: roundMm(box.x), y: roundMm(box.y), width: roundMm(box.width), height: roundMm(box.height) };
}
