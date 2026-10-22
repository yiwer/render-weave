/** 模板任务的资料装配：短核心与由权威参考生成的按需章节。 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256 } from './round-files.js';

export async function writeTemplateReference(materials: string, docs: string): Promise<void> {
  const text = (await readFile(join(materials, 'reference/template.md'), 'utf8')).replaceAll('\r\n', '\n');
  // 只在代码围栏之外按二级标题分章，示例 JSON 保持完整。
  const sections: { title: string; text: string }[] = [];
  let fence = false;
  for (const part of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const line = part.replace(/\n$/, '');
    if (line.startsWith('```')) fence = !fence;
    if (!fence && line.startsWith('## ')) sections.push({ title: line.slice(3), text: '' });
    if (!sections.length) sections.push({ title: '单位与资源', text: '' });
    sections.at(-1)!.text += part;
  }
  await mkdir(join(docs, 'dsl'), { recursive: true });
  const index = ['# 模板 DSL 索引', '', '按当前写法选择章节；起步读文件结构和常见错误。完整示例只在需要组合示例时读取。', '',
    `来源：agent/reference/template.md；SHA-256：${sha256(text)}`, '', '| 章节 | 文件 | 字符数 |', '|---|---|---:|'];
  for (const [i, section] of sections.entries()) {
    const file = `dsl/section-${String(i).padStart(2, '0')}.md`;
    await writeFile(join(docs, file), section.text);
    index.push(`| ${section.title} | [${file}](${file}) | ${section.text.length} |`);
  }
  await writeFile(join(docs, 'dsl-index.md'), index.join('\n') + '\n');
  const guide = (await readFile(join(materials, 'guide.md'), 'utf8')).replaceAll('\r\n', '\n');
  await writeFile(join(docs, 'template-guide.md'), '# 模板设计指导\n\n' +
    `来源：agent/guide.md 的模板章节；SHA-256：${sha256(guide)}\n\n` +
    (templateSection(guide) ?? '此资料包没有模板章节；以项目说明和模板任务核心为准。') + '\n');
}

function templateSection(text: string): string | undefined {
  const start = text.indexOf('\n## 模板\n');
  if (start < 0) return undefined;
  const end = text.indexOf('\n## ', start + 1);
  return text.slice(start + 1, end < 0 ? undefined : end);
}

/** 领域包的模板章节是现有权威来源；提取阶段的规则不复制进模板任务。 */
export async function writeTemplateDomain(source: string, target: string): Promise<void> {
  const text = (await readFile(source, 'utf8')).replaceAll('\r\n', '\n');
  const section = templateSection(text);
  if (!section) {
    await writeFile(target, '# 领域模板约定\n\n此领域包没有模板章节；以项目说明为准。\n');
    return;
  }
  const introduction = text.slice(0, text.indexOf('\n## '));
  await writeFile(target, introduction + '\n\n' + section + '\n');
}
