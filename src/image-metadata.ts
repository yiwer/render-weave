/**
 * 图片的 DPI 元数据：PNG 写 pHYs 块，JPEG 写 JFIF APP0 段的像素密度。
 * Skia 的编码器不写这些信息，所以在编码之后补上。
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const METERS_PER_INCH = 0.0254;

interface PngChunk {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly dataStart: number;
  readonly length: number;
}

function pngChunks(bytes: Uint8Array): PngChunk[] {
  if (!PNG_SIGNATURE.every((value, index) => bytes[index] === value)) throw new Error('不是 PNG 数据');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: PngChunk[] = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const end = offset + 12 + length;
    if (end > bytes.length) throw new Error('PNG 数据不完整');
    chunks.push({ type, start: offset, end, dataStart: offset + 8, length });
    offset = end;
    if (type === 'IEND') break;
  }
  return chunks;
}

/** 写入（或替换）pHYs 块，单位为像素每米。 */
export function setPngDpi(png: Uint8Array, dpi: number): Uint8Array {
  const chunks = pngChunks(png);
  const ihdr = chunks[0];
  if (!ihdr || ihdr.type !== 'IHDR') throw new Error('PNG 缺少 IHDR');
  const pixelsPerMeter = Math.round(dpi / METERS_PER_INCH);

  const phys = new Uint8Array(21);
  const view = new DataView(phys.buffer);
  view.setUint32(0, 9);
  phys.set([0x70, 0x48, 0x59, 0x73], 4); // pHYs
  view.setUint32(8, pixelsPerMeter);
  view.setUint32(12, pixelsPerMeter);
  phys[16] = 1; // 单位：米
  view.setUint32(17, crc32(phys.subarray(4, 17)));

  const parts: Uint8Array[] = [png.subarray(0, ihdr.end), phys];
  for (const chunk of chunks.slice(1)) {
    if (chunk.type !== 'pHYs') parts.push(png.subarray(chunk.start, chunk.end));
  }
  return concat(parts);
}

export function readPngInfo(png: Uint8Array): { width: number; height: number; dpi?: number } {
  const chunks = pngChunks(png);
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const ihdr = chunks[0];
  if (!ihdr || ihdr.type !== 'IHDR') throw new Error('PNG 缺少 IHDR');
  const info: { width: number; height: number; dpi?: number } = {
    width: view.getUint32(ihdr.dataStart),
    height: view.getUint32(ihdr.dataStart + 4),
  };
  const phys = chunks.find((chunk) => chunk.type === 'pHYs');
  if (phys && png[phys.dataStart + 8] === 1) {
    info.dpi = Math.round(view.getUint32(phys.dataStart) * METERS_PER_INCH);
  }
  return info;
}

/** 写入 JFIF APP0 段的像素密度（单位：每英寸）。没有 APP0 时在 SOI 之后插入一个。 */
export function setJpegDpi(jpeg: Uint8Array, dpi: number): Uint8Array {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('不是 JPEG 数据');
  const density = Math.min(0xffff, Math.round(dpi));
  if (hasJfifApp0(jpeg)) {
    const copy = jpeg.slice();
    const view = new DataView(copy.buffer);
    copy[13] = 1;
    view.setUint16(14, density);
    view.setUint16(16, density);
    return copy;
  }
  const app0 = new Uint8Array(18);
  const view = new DataView(app0.buffer);
  app0.set([0xff, 0xe0]);
  view.setUint16(2, 16);
  app0.set([0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01], 4); // "JFIF\0"，版本 1.1，单位：每英寸
  view.setUint16(12, density);
  view.setUint16(14, density);
  return concat([jpeg.subarray(0, 2), app0, jpeg.subarray(2)]);
}

export function readJpegDpi(jpeg: Uint8Array): number | undefined {
  if (!hasJfifApp0(jpeg) || jpeg[13] !== 1) return undefined;
  return new DataView(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength).getUint16(14);
}

function hasJfifApp0(jpeg: Uint8Array): boolean {
  return (
    jpeg.length > 18 &&
    jpeg[2] === 0xff &&
    jpeg[3] === 0xe0 &&
    jpeg[6] === 0x4a &&
    jpeg[7] === 0x46 &&
    jpeg[8] === 0x49 &&
    jpeg[9] === 0x46 &&
    jpeg[10] === 0x00
  );
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
