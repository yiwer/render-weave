/**
 * 从 OpenType/TrueType 字体文件读取排版需要的少量度量。
 *
 * 文本的行框取 OS/2 表的 sTypoAscender 与 sTypoDescender：对中文字体，这正是表意字的 em 框
 * （思源黑体为基线上 0.88 em、基线下 0.12 em），因此"随内容"的文本高度等于字号，
 * 字在框内的位置也与设计稿一致。hhea 的上下高度（思源黑体为 1.16 em 与 0.288 em）留有行距余量，不适合直接作行框。
 */

export interface FontMetricsInfo {
  readonly unitsPerEm: number;
  /** 基线以上的高度，em 单位，正数。 */
  readonly ascender: number;
  /** 基线以下的深度，em 单位，正数。 */
  readonly descender: number;
  readonly weightClass?: number;
}

/** 读不出 OS/2 或 head 表（如字体集合、WOFF）时返回 undefined，由调用方退回 Skia 的度量。 */
export function readFontMetrics(bytes: Uint8Array): FontMetricsInfo | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.byteLength < 12) return undefined;
  const version = view.getUint32(0);
  const isSfnt = version === 0x00010000 || version === 0x4f54544f /* OTTO */ || version === 0x74727565; /* true */
  if (!isSfnt) return undefined;

  const numTables = view.getUint16(4);
  const tables = new Map<string, { offset: number; length: number }>();
  for (let i = 0; i < numTables; i++) {
    const record = 12 + i * 16;
    if (record + 16 > view.byteLength) return undefined;
    const tag = String.fromCharCode(
      view.getUint8(record),
      view.getUint8(record + 1),
      view.getUint8(record + 2),
      view.getUint8(record + 3),
    );
    tables.set(tag, { offset: view.getUint32(record + 8), length: view.getUint32(record + 12) });
  }

  const head = tables.get('head');
  const os2 = tables.get('OS/2');
  if (!head || !os2 || head.offset + 20 > view.byteLength || os2.length < 74 || os2.offset + 74 > view.byteLength) {
    return undefined;
  }
  const unitsPerEm = view.getUint16(head.offset + 18);
  if (unitsPerEm === 0) return undefined;
  const typoAscender = view.getInt16(os2.offset + 68);
  const typoDescender = view.getInt16(os2.offset + 70);
  if (typoAscender - typoDescender <= 0) return undefined;
  return {
    unitsPerEm,
    ascender: typoAscender / unitsPerEm,
    descender: -typoDescender / unitsPerEm,
    weightClass: view.getUint16(os2.offset + 4),
  };
}
