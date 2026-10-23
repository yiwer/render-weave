/** 资料策略只决定现有参考何时可见；规则原文与公开参考共用一份来源。 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { materialHashes } from './provenance.js';
import { AgentUsageError, sha256 } from './round-files.js';
import {referenceTexts,type ReferenceTexts} from '../mcp/references.js';

const root = fileURLToPath(new URL('../../agent/', import.meta.url));
export type ContextPolicy = 'full' | 'on-demand';
export interface ContextPolicyIdentity {
  readonly name: ContextPolicy;
  readonly id: string;
  readonly available: Readonly<Record<string, string>>;
  readonly entry: Readonly<Record<string, string>>;
}
export function contextPolicy(value: string | undefined): ContextPolicy {
  if (value !== undefined && value !== 'full' && value !== 'on-demand') throw new AgentUsageError('--context-policy 只能取 full 或 on-demand');
  return value ?? 'full';
}
/** 截取现有权威参考原文；标题变动会明确失败，不能静默丢掉强制约束。 */
function section(text: string, heading: string): string {
  const lines = text.split(/\r?\n/), index = lines.findIndex(line => line === `## ${heading}`);
  if (index < 0) throw new AgentUsageError(`按需资料缺少强制参考章节：${heading}`);
  const next = lines.findIndex((line, i) => i > index && line.startsWith('## '));
  return lines.slice(index, next < 0 ? undefined : next).join('\n');
}
export async function prepareContextPolicy(policy: ContextPolicy, docs: string, references: ReferenceTexts): Promise<void> {
  if (policy === 'full') return;
  const template = references['reference/template'];
  const definition = references['reference/data-definition'];
  const scope = template.split(/\r?\n/).find(line => line.includes('作用域不继承'));
  if (!scope) throw new AgentUsageError('按需资料缺少作用域约束');
  await writeFile(join(docs, 'constraints.md'), '# 入口约束（现有参考原文摘录）\n\n来源：dsl_reference reference/template、reference/data-definition。完整规则经同一公开参考读取。\n\n'
    + template.slice(0, template.indexOf('## 文件结构')) + section(template, '文件结构') + '\n' + section(template, '常见错误') + '\n' + scope + '\n\n'
    + section(definition, '数据定义（renderweave-schema/1）'));
  await writeFile(join(docs, 'context-catalog.json'), await readFile(join(root, 'context-catalog.json')));
}
export function contextPrompt(prompt: string, policy: ContextPolicy): string {
  if (policy === 'full') return prompt;
  return prompt.replaceAll('dsl-reference.md', 'constraints.md（入口约束）；按 docs/context-catalog.json 的阶段使用 dsl_reference 读取完整参考')
    + '\n按需资料：先读 docs/constraints.md、docs/guide.md、docs/outcome.md、项目说明和本轮反馈/修改要求。docs/context-catalog.json 的 name 是 dsl_reference 参数；heading 是返回原文中的章节定位提示，不能把目录当作完整规则。遇到缺少或无效参考，报告错误并保留待确认，不猜测 DSL。check_outcome 返回 feedback.reportId；修改前用 outcome_feedback 按 nextOffset 读完同一报告的局部问题与未知范围，超长 fragment 按 itemId/index 拼接读取。分页不检查当前字节，修改后须重新 check_outcome。\n';
}
export async function contextIdentity(policy: ContextPolicy, docs: string, references:ReferenceTexts): Promise<ContextPolicyIdentity> {
  const available = Object.fromEntries(Object.entries(references).map(([name,text])=>[name,sha256(Buffer.from(text))]));
  const entry = await materialHashes(docs, 'materials');
  return {name:policy,id:sha256(Buffer.from(JSON.stringify({name:policy,available,entry}))),available,entry};
}
export async function contextStrategyIdentity(policy:ContextPolicy) {
  const sources={...await materialHashes(root,'agent'),...Object.fromEntries(Object.entries(await referenceTexts()).map(([name,text])=>[name,sha256(Buffer.from(text))]))};
  const scope={mandatory:['guide.md','reference/outcome.md','brief.md','domain (if supplied)','request/requirement/feedback (if supplied)'],
    entry:policy==='full'?['task reference (whole)']:['context-catalog.json','reference/template: intro, 文件结构, 常见错误, 作用域不继承','reference/data-definition: 数据定义（renderweave-schema/1）'],
    deferred:policy==='full'?[]:['reference/data-definition','reference/template','schema/*']};
  return {name:policy,id:sha256(Buffer.from(JSON.stringify({name:policy,scope,sources}))),scope,sources};
}
