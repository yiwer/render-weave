import QRCode from 'qrcode';
import { formatElementPath } from '../element-path.js';
import { ProblemCodes, severe, type Problem, type ProblemCode } from '../problems.js';
import type { QrCodeModel } from '../template/model.js';
import { pxPerMm, roundMm } from '../units.js';
import type { Box, DrawOp, QrCodeSummary } from './types.js';

/** QR 字节模式的最大容量（版本 40、L）；先限长再编码，避免无界编码开销。 */
const MAX_BYTES = 2953;

export function recordQrCode(
  model: QrCodeModel, box: Box, dpi: number, ops: DrawOp[], problems: Problem[],
): QrCodeSummary | undefined {
  const fail = (code: ProblemCode, message: string): undefined => {
    problems.push(severe(code, { kind: 'element', path: formatElementPath(model.path) }, message));
    return undefined;
  };
  if (!model.content.length || /[\uD800-\uDFFF]/u.test(model.content)) {
    return fail(ProblemCodes.qrContentInvalid, '二维码内容不能为空，且必须是有效的 Unicode 文本');
  }
  if (!model.foreground.endsWith('FF') || !model.background.endsWith('FF') || model.foreground === model.background) {
    return fail(ProblemCodes.qrColorsInvalid, '二维码前景和背景必须是不透明且不同的颜色');
  }
  if (model.place.width?.kind === 'hug' || model.place.height?.kind === 'hug' || box.width <= 0 || box.height <= 0) {
    return fail(ProblemCodes.qrSizeInvalid, '二维码需要确定的宽高，不支持随内容尺寸');
  }
  if (Buffer.byteLength(model.content, 'utf8') > MAX_BYTES) {
    return fail(ProblemCodes.qrCapacityExceeded, `二维码 UTF-8 内容超过字节模式上限 ${MAX_BYTES} 字节`);
  }
  let encoded: ReturnType<typeof QRCode.create>;
  try {
    // 显式使用 UTF-8 字节模式，不依赖平台字符集或可变的自动分段策略。
    encoded = QRCode.create([{ data: Buffer.from(model.content, 'utf8'), mode: 'byte' }], { errorCorrectionLevel: model.errorCorrectionLevel });
  } catch {
    return fail(ProblemCodes.qrCapacityExceeded, `二维码内容超过纠错等级 ${model.errorCorrectionLevel} 的容量`);
  }
  const modules = encoded.modules.size;
  const scale = pxPerMm(dpi);
  // 向内取整数像素边界，保证四模块留白也完全在元素框中。
  const left = Math.ceil(box.x * scale - 1e-7);
  const top = Math.ceil(box.y * scale - 1e-7);
  const width = Math.floor((box.x + box.width) * scale + 1e-7) - left;
  const height = Math.floor((box.y + box.height) * scale + 1e-7) - top;
  const moduleSizePx = Math.floor(Math.min(width, height) / (modules + 8));
  if (moduleSizePx < 2) {
    return fail(ProblemCodes.qrSizeInvalid, `二维码 ${modules} × ${modules} 模块加四边各 4 模块留白，每模块至少 2 px；当前框 ${width} × ${height} px 不足`);
  }
  const side = (modules + 8) * moduleSizePx;
  const x = (left + Math.floor((width - side) / 2)) / scale;
  const y = (top + Math.floor((height - side) / 2)) / scale;
  const moduleSize = moduleSizePx / scale;
  ops.push({ op: 'qrcode', x, y, moduleSize, modules, data: encoded.modules.data,
    foreground: model.foreground, background: model.background });
  const quiet = 4 * moduleSize;
  const square = (x: number, y: number, side: number): Box => ({ x: roundMm(x), y: roundMm(y), width: roundMm(side), height: roundMm(side) });
  return { format: 'qr', errorCorrectionLevel: model.errorCorrectionLevel, modules, moduleSizePx,
    quietZoneModules: 4, quietZoneMm: roundMm(quiet), drawn: square(x, y, side / scale),
    symbol: square(x + quiet, y + quiet, modules * moduleSize) };
}
