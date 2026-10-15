import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { ProblemCodes, checkDslDocument, openResourceRepository, publishStaticSchema, render, type Problem, type StaticSchemaEntry } from '../src/index.js';
import { loadCorpus, loadSchemas, type CorpusDocument } from './support/dsl-corpus.js';
import { repoRoot, resourcesDir, withEmptyTemplate } from './support/fixtures.js';

/**
 * DSL 1.0 一致性（M219）：`schemas/` 中的 JSON Schema 与引擎对同一批文档的判断一致。本文件覆盖数据定义与数据集，
 * 模板与请求见 dsl-template-schema.test.ts。
 * - 仓库内的语料：Schema 拒绝的，引擎一定拒绝；引擎拒绝而 Schema 接受的，只能是列明的语义检查。
 * - 变异样本：结构错误被两边同时拒绝。
 */

const isDefinition = (d: Record<string, unknown>) => typeof d['dslVersion'] === 'string' && d['dslVersion'].startsWith('renderweave-schema/');
const isDataset = (d: Record<string, unknown>) => !('dslVersion' in d) && 'dataset' in d && 'data' in d;

/**
 * Schema 表达不了、只看一份文档就能判断的语义检查（docs/dsl/data-definition.md「Schema 之外的检查」）。
 * 需要其他文档的检查（引用不存在或成环、版本号与发布不符、数据不符合编译产物）由 schema.test.ts 与 render.test.ts 覆盖。
 */
const SEMANTIC_CHECKS: readonly { readonly name: string; readonly matches: (p: Problem) => boolean }[] = [
  { name: '约束冲突', matches: (p) => p.code === ProblemCodes.definitionConstraintConflict },
  { name: '正则不合法', matches: (p) => p.code === ProblemCodes.definitionInvalid && p.message.includes('不是合法的正则表达式') },
  { name: '有效数字超过 15 位', matches: (p) => p.code === ProblemCodes.definitionInvalid && p.message.includes('有效数字') },
  { name: '字段名称重复', matches: (p) => p.code === ProblemCodes.definitionInvalid && /字段名称 \S+ 重复/.test(p.message) },
];
const isSemantic = (p: Problem) => SEMANTIC_CHECKS.some((check) => check.matches(p));

let corpus: CorpusDocument[] = [];
let definitionSchema: ValidateFunction;
let datasetSchema: ValidateFunction;

beforeAll(async () => {
  const schemas = await loadSchemas();
  definitionSchema = schemas.definition;
  datasetSchema = schemas.dataset;
  corpus = await loadCorpus();
});

describe('语料与 Schema 一致', () => {
  it('仓库中的数据定义：有效的都通过 Schema，Schema 拒绝的引擎都拒绝', () => {
    const definitions = corpus.filter((c) => c.kind === 'definition');
    expect(definitions.length).toBeGreaterThan(5);
    const disagreements: string[] = [];
    let valid = 0;
    for (const { source, document } of definitions) {
      const schemaOk = definitionSchema(document);
      const severe = checkDslDocument(document, source).problems.filter((p) => p.level === 'severe');
      if (severe.length === 0) valid++;
      if (severe.length === 0 && !schemaOk) disagreements.push(`${source}：引擎接受，Schema 拒绝 ${JSON.stringify(definitionSchema.errors?.slice(0, 2))}`);
      if (severe.length > 0 && schemaOk && !severe.every(isSemantic)) disagreements.push(`${source}：Schema 接受，引擎因非语义问题拒绝 ${severe.map((p) => p.message).join('；')}`);
    }
    expect(disagreements).toEqual([]);
    expect(valid).toBeGreaterThan(5);
  });

  it('仓库中的数据集文档：有效的都通过 Schema，Schema 拒绝的引擎都拒绝', () => {
    const datasets = corpus.filter((c) => c.kind === 'dataset');
    expect(datasets.length).toBeGreaterThan(3);
    const disagreements: string[] = [];
    for (const { source, document } of datasets) {
      const schemaOk = datasetSchema(document);
      const engineOk = checkDslDocument(document, source).problems.length === 0;
      if (schemaOk !== engineOk) disagreements.push(`${source}：Schema ${schemaOk ? '接受' : '拒绝'}，引擎${engineOk ? '接受' : '拒绝'}`);
    }
    expect(disagreements).toEqual([]);
  });
});

type Mutation = readonly [label: string, mutate: (doc: any) => boolean];

/** 结构错误的变异：每个都应同时被 Schema 与引擎拒绝。返回 false 表示这份文档不适用此变异。 */
const DEFINITION_MUTATIONS: readonly Mutation[] = [
  ['根上未知键', (d) => ((d.extra = 1), true)],
  ['缺 dslVersion', (d) => (delete d.dslVersion, true)],
  ['dslVersion 版本不对', (d) => ((d.dslVersion = 'renderweave-schema/2'), true)],
  ['name 不是文本', (d) => ((d.name = 123), true)],
  ['name 为空白', (d) => ((d.name = '  '), true)],
  ['version 为 0', (d) => ((d.version = 0), true)],
  ['version 不是整数', (d) => ((d.version = 1.5), true)],
  ['displayName 为 null', (d) => ((d.displayName = null), true)],
  ['description 不是文本', (d) => ((d.description = 5), true)],
  ['fields 不是列表', (d) => ((d.fields = {}), true)],
  ['字段上未知键', (d) => field(d, () => true, (f) => (f.extra = 1))],
  ['字段缺 displayName', (d) => field(d, () => true, (f) => delete f.displayName)],
  ['字段缺 type', (d) => field(d, () => true, (f) => delete f.type)],
  ['字段 type 未知', (d) => field(d, () => true, (f) => (f.type = 'string'))],
  ['字段名称以数字开头', (d) => field(d, () => true, (f) => (f.name = '1abc'))],
  ['字段名称含点', (d) => field(d, () => true, (f) => (f.name = 'a.b'))],
  ['字段 displayName 为空', (d) => field(d, () => true, (f) => (f.displayName = ''))],
  ['字段 description 不是文本', (d) => field(d, () => true, (f) => (f.description = 1))],
  ['constraints 为 null', (d) => field(d, () => true, (f) => (f.constraints = null))],
  ['constraints 是列表', (d) => field(d, () => true, (f) => (f.constraints = []))],
  ['required 不是布尔', (d) => field(d, () => true, (f) => (f.constraints = { ...f.constraints, required: 'yes' }))],
  ['类型不允许的约束', (d) => field(d, (f) => f.type !== 'number', (f) => (f.constraints = { ...f.constraints, min: 1 }))],
  ['text 长度为负', (d) => field(d, (f) => f.type === 'text', (f) => (f.constraints = { ...f.constraints, minLength: -1 }))],
  ['text 长度不是整数', (d) => field(d, (f) => f.type === 'text', (f) => (f.constraints = { ...f.constraints, maxLength: 1.5 }))],
  ['text enum 为空', (d) => field(d, (f) => f.type === 'text', (f) => (f.constraints = { ...f.constraints, enum: [] }))],
  ['text enum 不是文本', (d) => field(d, (f) => f.type === 'text', (f) => (f.constraints = { ...f.constraints, enum: [1] }))],
  ['text pattern 不是文本', (d) => field(d, (f) => f.type === 'text', (f) => (f.constraints = { ...f.constraints, pattern: 1 }))],
  ['number min 不是数值', (d) => field(d, (f) => f.type === 'number', (f) => (f.constraints = { ...f.constraints, min: 'a' }))],
  ['number integer 不是布尔', (d) => field(d, (f) => f.type === 'number', (f) => (f.constraints = { ...f.constraints, integer: 'yes' }))],
  ['image 来源未知', (d) => field(d, (f) => f.type === 'image', (f) => (f.constraints = { ...f.constraints, allowedSources: ['ftp'] }))],
  ['image 来源为空', (d) => field(d, (f) => f.type === 'image', (f) => (f.constraints = { ...f.constraints, allowedSources: [] }))],
  ['image 来源为 null', (d) => field(d, (f) => f.type === 'image', (f) => (f.constraints = { ...f.constraints, allowedSources: null }))],
  ['list 项数为负', (d) => field(d, (f) => f.type === 'list', (f) => (f.constraints = { ...f.constraints, minItems: -1 }))],
  ['list 缺 items', (d) => field(d, (f) => f.type === 'list', (f) => delete f.items)],
  ['list 元素又是列表', (d) => field(d, (f) => f.type === 'list', (f) => (f.items = { type: 'list', items: { type: 'text' } }))],
  ['list 元素上未知键', (d) => field(d, (f) => f.type === 'list', (f) => (f.items = { ...f.items, extra: 1 }))],
  ['list 元素写 required', (d) => field(d, (f) => f.type === 'list', (f) => (f.items = { ...f.items, constraints: { ...f.items.constraints, required: true } }))],
  ['非列表写 items', (d) => field(d, (f) => f.type !== 'list', (f) => (f.items = { type: 'text' }))],
  ['非引用写 ref', (d) => field(d, (f) => f.type !== 'ref', (f) => (f.ref = { name: '停靠站点', version: 1 }))],
  ['引用缺版本', (d) => refOf(d, (r) => delete r.version)],
  ['引用上未知键', (d) => refOf(d, (r) => (r.extra = 1))],
  ['引用版本为 0', (d) => refOf(d, (r) => (r.version = 0))],
];

const DATASET_MUTATIONS: readonly Mutation[] = [
  ['根上未知键', (d) => ((d.extra = 1), true)],
  ['缺 data', (d) => (delete d.data, true)],
  ['dataset 不是对象', (d) => ((d.dataset = null), true)],
  ['缺 staticSchema', (d) => (delete d.dataset.staticSchema, true)],
  ['staticSchema 版本为 0', (d) => ((d.dataset.staticSchema.version = 0), true)],
  ['staticSchema 上未知键', (d) => ((d.dataset.staticSchema.extra = 1), true)],
  ['staticSchema 名称为空', (d) => ((d.dataset.staticSchema.name = ''), true)],
  ['id 不是文本', (d) => ((d.dataset.id = 5), true)],
];

function field(doc: any, applies: (f: any) => boolean, mutate: (f: any) => unknown): boolean {
  const target = Array.isArray(doc.fields) ? doc.fields.find(applies) : undefined;
  if (!target) return false;
  mutate(target);
  return true;
}

function refOf(doc: any, mutate: (r: any) => unknown): boolean {
  for (const f of Array.isArray(doc.fields) ? doc.fields : []) {
    const holder = f.type === 'ref' ? f : f.type === 'list' && f.items?.type === 'ref' ? f.items : undefined;
    if (holder?.ref && typeof holder.ref === 'object') {
      mutate(holder.ref);
      return true;
    }
  }
  return false;
}

function runMutations(documents: readonly CorpusDocument[], mutations: readonly Mutation[], schema: () => ValidateFunction): { applied: Set<string>; escapes: string[] } {
  const applied = new Set<string>();
  const escapes: string[] = [];
  for (const { source, document } of documents) {
    for (const [label, mutate] of mutations) {
      const mutant = structuredClone(document);
      if (!mutate(mutant)) continue;
      applied.add(label);
      const schemaRejects = !schema()(mutant);
      const engineRejects = checkDslDocument(mutant, source).problems.some((p) => p.level === 'severe');
      if (!schemaRejects || !engineRejects) escapes.push(`${source}「${label}」：Schema ${schemaRejects ? '拒绝' : '接受'}，引擎${engineRejects ? '拒绝' : '接受'}`);
    }
  }
  return { applied, escapes };
}

describe('结构错误被 Schema 与引擎同时拒绝', () => {
  it('数据定义的变异样本', () => {
    const valid = corpus.filter((c) => c.kind === 'definition' && checkDslDocument(c.document).problems.length === 0);
    const { applied, escapes } = runMutations(valid, DEFINITION_MUTATIONS, () => definitionSchema);
    expect(escapes).toEqual([]);
    // 每种变异至少在一份语料上用到，否则说明语料缺少对应写法。
    expect(DEFINITION_MUTATIONS.map(([label]) => label).filter((label) => !applied.has(label))).toEqual([]);
  });

  it('数据集文档的变异样本', () => {
    const valid = corpus.filter((c) => c.kind === 'dataset' && checkDslDocument(c.document).problems.length === 0);
    const { applied, escapes } = runMutations(valid, DATASET_MUTATIONS, () => datasetSchema);
    expect(escapes).toEqual([]);
    expect(applied.size).toBe(DATASET_MUTATIONS.length);
  });
});

describe('Schema 之外的语义检查（只看一份文档）', () => {
  const base = (fields: unknown[]) => ({ dslVersion: 'renderweave-schema/1', name: '样例', fields });
  const cases: readonly [string, Record<string, unknown>][] = [
    ['约束冲突', base([{ name: 'code', displayName: '编号', type: 'text', constraints: { minLength: 5, maxLength: 2 } }])],
    ['约束冲突', base([{ name: 'kind', displayName: '种类', type: 'text', constraints: { maxLength: 2, enum: ['很长的取值'] } }])],
    ['约束冲突', base([{ name: 'n', displayName: '数', type: 'number', constraints: { integer: true, min: 1.2, max: 1.8 } }])],
    ['正则不合法', base([{ name: 'code', displayName: '编号', type: 'text', constraints: { pattern: '([' } }])],
    ['有效数字超过 15 位', base([{ name: 'n', displayName: '数', type: 'number', constraints: { max: 1234567890.1234567 } }])],
    ['字段名称重复', base([{ name: 'a', displayName: '甲', type: 'text' }, { name: 'a', displayName: '乙', type: 'text' }])],
  ];

  it.each(cases)('%s：Schema 接受，引擎拒绝并归入该类', (category, document) => {
    expect(definitionSchema(document)).toBe(true);
    const problems = checkDslDocument(document).problems;
    expect(problems.length).toBeGreaterThan(0);
    const check = SEMANTIC_CHECKS.find((c) => c.name === category)!;
    expect(problems.every(check.matches)).toBe(true);
  });

  it('清单中的每一类都有用例', () => {
    expect(new Set(cases.map(([category]) => category))).toEqual(new Set(SEMANTIC_CHECKS.map((c) => c.name)));
  });
});

describe('文档识别', () => {
  it('既不是数据定义也不是数据集的文档报无法识别', () => {
    const { kind, problems } = checkDslDocument({ template: 'x' }, 'request.json');
    expect(kind).toBeUndefined();
    expect(problems.map((p) => p.code)).toEqual([ProblemCodes.inputUnreadable]);
  });
});

describe('参考文档', () => {
  const REFERENCES = ['docs/dsl/data-definition.md', 'agent/reference/data-definition.md'];

  async function jsonBlocks(file: string): Promise<Record<string, unknown>[]> {
    const text = await readFile(join(repoRoot, file), 'utf8');
    return [...text.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]!) as Record<string, unknown>);
  }

  it.each(REFERENCES)('%s 的示例：数据定义依次发布，数据集按其校验，均为 0 问题', async (file) => {
    const blocks = await jsonBlocks(file);
    const entries: StaticSchemaEntry[] = [];
    for (const document of blocks.filter(isDefinition)) {
      const { published, problems } = publishStaticSchema(document, entries);
      expect(problems).toEqual([]);
      entries.push(published!);
    }
    const datasets = blocks.filter(isDataset);
    expect(entries.length).toBeGreaterThan(0);
    expect(datasets.length).toBeGreaterThan(0);
    const { repository } = await openResourceRepository(resourcesDir);
    for (const dataset of datasets) {
      const base = (dataset['dataset'] as { staticSchema: { name: string; version: number } }).staticSchema;
      const workspace = withEmptyTemplate({ staticSchemas: entries, templates: [], datasets: [], resources: repository, problems: [] }, '空模板', base);
      const result = await render(workspace, {
        template: '空模板', dataset: { inline: dataset }, output: { width: 10, height: 10, dpi: 30, format: 'png' }, mode: 'draft',
      });
      expect(result.problems).toEqual([]);
    }
  });

  it('两份参考覆盖 Schema 中的全部顶层键、字段键、类型与约束', async () => {
    const schema = JSON.parse(await readFile(join(repoRoot, 'schemas', 'data-definition.schema.json'), 'utf8'));
    const defs = schema.$defs;
    const keywords = new Set<string>([
      ...Object.keys(schema.properties),
      ...Object.keys(defs.field.properties),
      ...defs.field.properties.type.enum,
      ...['textConstraints', 'numberConstraints', 'imageConstraints', 'listConstraints'].flatMap((name) => Object.keys(defs[name].properties)),
    ]);
    for (const file of REFERENCES) {
      const text = await readFile(join(repoRoot, file), 'utf8');
      expect([...keywords].filter((keyword) => !text.includes(keyword)), file).toEqual([]);
    }
  });
});
