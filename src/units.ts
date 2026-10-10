/** 模板与布局一律以毫米为单位；只在栅格化时按 DPI 换算像素。 */

export const MM_PER_INCH = 25.4;

/** 像素数 = 毫米 ÷ 25.4 × DPI，四舍五入为整数（M100）。740 mm、120 DPI 得 3496 像素。 */
export function mmToPx(mm: number, dpi: number): number {
  return Math.round((mm / MM_PER_INCH) * dpi);
}

export function pxPerMm(dpi: number): number {
  return dpi / MM_PER_INCH;
}

/** 布局摘要中的毫米值保留三位小数，避免浮点尾数影响快照。 */
export function roundMm(value: number): number {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? 0 : rounded;
}
