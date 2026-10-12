/** 在排版前逐码点选择字体；拆分后的片段同时用于测量、绘制和摘要。 */
import { formatElementPath } from '../element-path.js';
import type { EvaluatedFragment, EvaluatedNode } from '../evaluate.js';
import { hint, ProblemCodes, severe, type Problem } from '../problems.js';
import type { FontStore } from './fonts.js';

export async function resolveGlyphFallbacks(node: EvaluatedNode, fonts: FontStore, problems: Problem[]): Promise<EvaluatedNode> {
  if (node.model.type !== 'artboard' && !node.model.visible) return node;
  if (node.model.type !== 'text') {
    if (!node.children) return node;
    const children: EvaluatedNode[] = [];
    for (const child of node.children) children.push(await resolveGlyphFallbacks(child, fonts, problems));
    return { ...node, children };
  }

  const fragments: EvaluatedFragment[] = [];
  const replaced = new Set<string>();
  const missing = new Set<string>();
  for (const fragment of node.fragments ?? []) {
    const original = fonts.get(fragment.style.font);
    const ids = original && fonts.glyphIds(original, fragment.text);
    if (!original || !ids?.includes(0)) {
      fragments.push(fragment);
      continue;
    }
    const fallback = await fonts.fallbackFor(original);
    const fallbackIds = fallback && fonts.glyphIds(fallback, fragment.text);
    // 只在当前片段内合并连续相同字体，保留原有片段的样式与边界。
    let run: EvaluatedFragment | undefined;
    Array.from(fragment.text).forEach((char, i) => {
      const substitute = ids[i] === 0 && fallback && (fallbackIds?.[i] ?? 0) > 0;
      if (ids[i] === 0) (substitute ? replaced : missing).add(char);
      const font = substitute ? fallback.id : original.id;
      if (run?.style.font === font) {
        run = { ...run, text: run.text + char };
        fragments[fragments.length - 1] = run;
      } else {
        run = { text: char, style: { ...fragment.style, font }, ...(fragment.placeholder && { placeholder: fragment.placeholder }),
          ...(substitute && { sourceFont: original.id }) };
        fragments.push(run);
      }
    });
  }
  const location = { kind: 'element' as const, path: formatElementPath(node.model.path) };
  if (replaced.size) problems.push(hint(ProblemCodes.textGlyphFallback, location,
    `缺字已按字重用后备字体逐字替代：${describe(replaced)}`));
  if (missing.size) problems.push(severe(ProblemCodes.textGlyphMissing, location,
    `原字体与配置的后备字体无法显示这些字（没有可用后备字体或替代后仍缺字）：${describe(missing)}`));
  return { ...node, fragments };
}

function describe(chars: ReadonlySet<string>): string {
  return [...chars].map((char) => `${JSON.stringify(char)} (U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')})`).join('、');
}
