/**
 * 可选值列表（M390）：页面上一项一个输入框，文档里是约束的 enum。
 * 纯函数：空的项不进文档；数值枚举读不成数的原样写回，校验一律以服务端的问题清单为准（M351）。
 */

/** 文档里的 enum 读成每一项的文字。 */
export const enumTexts = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);

const parsed = (text: string, numeric: boolean): string | number => {
  const trimmed = text.trim();
  return numeric && !Number.isNaN(Number(trimmed)) ? Number(trimmed) : trimmed;
};

/** 每一项的文字写回 enum：去掉首尾空白，空的项不算；一项都没有就是没有这条约束。 */
export function enumValue(texts: readonly string[], numeric: boolean): (string | number)[] | undefined {
  const values = texts.filter((text) => text.trim()).map((text) => parsed(text, numeric));
  return values.length ? values : undefined;
}

/** 和前面某一项重复的序号：页面上当场提示，发布时服务端同样拒绝（definition.constraintConflict）。数值按值比，1 与 1.0 算重复。 */
export function duplicateIndexes(texts: readonly string[], numeric: boolean): ReadonlySet<number> {
  const seen = new Set<string | number>(), duplicates = new Set<number>();
  texts.forEach((text, index) => {
    if (!text.trim()) return;
    const value = parsed(text, numeric);
    if (seen.has(value)) duplicates.add(index);
    seen.add(value);
  });
  return duplicates;
}

/** 粘贴的文字按行拆开，去掉首尾空白与空行。 */
export const pastedLines = (text: string): string[] => text.split(/\r\n|\r|\n/).map((line) => line.trim()).filter(Boolean);
