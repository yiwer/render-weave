/**
 * 字体按字体族分组列字重（M115）：字重靠换字体资源，选的仍是资源引用。
 * 资源接口只回答 ID，没有字体族的元数据，所以按资源 ID 的命名约定拆：font-族-字重；认不出字重的单独算一族。
 */

const WEIGHTS: readonly (readonly [string, string])[] = [
  ['thin', 'Thin'], ['extralight', 'ExtraLight'], ['light', 'Light'], ['regular', 'Regular'], ['normal', 'Regular'], ['medium', 'Medium'],
  ['semibold', 'SemiBold'], ['bold', 'Bold'], ['heavy', 'Heavy'], ['black', 'Black'],
];

export interface FontChoice { readonly ref: string; readonly weight: string }
export interface FontFamily { readonly family: string; readonly fonts: readonly FontChoice[] }

const weightRank = (weight: string) => WEIGHTS.findIndex(([, label]) => label === weight);

export function fontFamilies(ids: readonly string[]): readonly FontFamily[] {
  const families = new Map<string, FontChoice[]>();
  for (const id of ids) {
    const parts = id.replace(/^font-/u, '').split('-'), last = parts.at(-1)!.toLowerCase();
    const known = parts.length > 1 ? WEIGHTS.find(([key]) => key === last) : undefined;
    const family = known ? parts.slice(0, -1).join('-') : parts.join('-');
    families.set(family, [...(families.get(family) ?? []), { ref: `res:${id}`, weight: known ? known[1] : 'Regular' }]);
  }
  return [...families].map(([family, fonts]) => ({ family, fonts: [...fonts].sort((a, b) => weightRank(a.weight) - weightRank(b.weight)) })).sort((a, b) => a.family.localeCompare(b.family));
}

/** 这个引用在哪一族；资源库里没有的引用不属于任何一族。 */
export const familyOf = (families: readonly FontFamily[], ref: string): FontFamily | undefined => families.find((family) => family.fonts.some((font) => font.ref === ref));

/** 换字体族（第三轮票据 04）：字重留着；这一族没有这个字重时取 Regular，再没有取最细的那个。写回的仍是资源引用。 */
export function fontInFamily(family: FontFamily, weight: string | undefined): string {
  return (family.fonts.find((font) => font.weight === weight) ?? family.fonts.find((font) => font.weight === 'Regular') ?? family.fonts[0]!).ref;
}
