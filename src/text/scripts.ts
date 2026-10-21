/**
 * 引擎按字逐个从左往右排（M106），不做字形塑形与双向排版。
 * 这里列出这样排出来与原文不一致的文字：从右往左的文字，以及需要字形组合的文字（票据 26）。
 */

interface ScriptRange {
  readonly name: string;
  readonly ranges: readonly (readonly [number, number])[];
  /** 区段内照样能正确显示的码点，如东阿拉伯数字：不连写、从左往右。 */
  readonly except?: readonly (readonly [number, number])[];
}

const UNSHAPED_SCRIPTS: readonly ScriptRange[] = [
  { name: '希伯来文', ranges: [[0x0590, 0x05ff], [0xfb1d, 0xfb4f]] },
  { name: '阿拉伯文', ranges: [[0x0600, 0x06ff], [0x0750, 0x077f], [0x0870, 0x08ff], [0xfb50, 0xfdff], [0xfe70, 0xfeff]],
    except: [[0x0660, 0x0669], [0x06f0, 0x06f9]] },
  { name: '叙利亚文', ranges: [[0x0700, 0x074f]] },
  { name: '它拿那文', ranges: [[0x0780, 0x07bf]] },
  { name: "N'Ko 文", ranges: [[0x07c0, 0x07ff]] },
  { name: '撒马利亚文与曼达文', ranges: [[0x0800, 0x085f]] },
  { name: '印度系文字', ranges: [[0x0900, 0x0dff]] },
  { name: '泰文与老挝文', ranges: [[0x0e00, 0x0eff]] },
  { name: '藏文', ranges: [[0x0f00, 0x0fff]] },
  { name: '缅甸文', ranges: [[0x1000, 0x109f]] },
  { name: '高棉文', ranges: [[0x1780, 0x17ff]] },
  { name: '蒙古文', ranges: [[0x1800, 0x18af]] },
];

const inRanges = (code: number, ranges: readonly (readonly [number, number])[]) => ranges.some(([from, to]) => code >= from && code <= to);

/** 文字中需要塑形或从右往左的字，按文字种类分组，保持首次出现的顺序并去重。 */
export function unshapedScripts(text: string): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const char of text) {
    const code = char.codePointAt(0)!;
    const script = UNSHAPED_SCRIPTS.find((entry) => inRanges(code, entry.ranges) && !inRanges(code, entry.except ?? []));
    if (!script) continue;
    const chars = found.get(script.name) ?? new Set<string>();
    chars.add(char);
    found.set(script.name, chars);
  }
  return found;
}
