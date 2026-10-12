import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExitCodes, runCli } from '../src/cli.js';
import {
  ProblemCodes,
  compileStaticSchema,
  loadWorkspace,
  publishStaticSchema,
  render,
  type Problem,
  type StaticSchemaEntry,
  type Workspace,
} from '../src/index.js';
import {
  M402_IMAGE_IDS,
  imageOnlyResources,
  loadSingleText,
  m402Dir,
  repoRoot,
  resourcesDir,
  singleTextDir,
  skeletonDir,
  stopNameDir,
  withEmptyTemplate,
} from './support/fixtures.js';

const readDraft = async (file: string) => JSON.parse(await readFile(join(m402Dir, file), 'utf8'));
const where = (problems: readonly Problem[]) => problems.map((p) => [p.code, 'path' in p.location ? p.location.path : p.location]);

function definition(fields: unknown[], name = '样例'): Record<string, unknown> {
  return { dslVersion: 'renderweave-schema/1', name, displayName: name, fields };
}

function publishAll(documents: unknown[]): StaticSchemaEntry[] {
  const entries: StaticSchemaEntry[] = [];
  for (const document of documents) {
    const { published, problems } = publishStaticSchema(document, entries);
    if (!published) throw new Error(JSON.stringify(problems));
    entries.push(published);
  }
  return entries;
}

describe('发布静态数据定义', () => {
  it('M402 两份数据定义发布后，编译产物与 DSL 草稿一致', async () => {
    const [stop, route] = publishAll([await readDraft('schema-stop-v1.json'), await readDraft('schema-route-sign-v1.json')]);

    expect(stop!.ref).toEqual({ name: '停靠站点', version: 1 });
    expect(route!.ref).toEqual({ name: '线路牌', version: 1 });
    expect(route!.compiled).toEqual(await readDraft('compiled-route-sign-v1.schema.json'));
    expect(stop!.compiled).toEqual(await readDraft('compiled-stop-v1.schema.json'));
    // 线路牌内联展开的停靠站点与停靠站点自己的编译产物一致。
    const { $schema: _schema, title: _title, ...stopBody } = stop!.compiled as Record<string, unknown>;
    expect((route!.compiled as any).properties.stops.items).toEqual(stopBody);
  });

  it('版本号自动递增；已发布的版本不能再次发布', async () => {
    const [stop] = publishAll([await readDraft('schema-stop-v1.json')]);
    const { version: _version, ...unversioned } = await readDraft('schema-stop-v1.json');
    const next = publishStaticSchema(unversioned, [stop!]);
    const again = publishStaticSchema(await readDraft('schema-stop-v1.json'), [stop!]);

    expect(next.published?.ref).toEqual({ name: '停靠站点', version: 2 });
    expect(next.published?.definition['version']).toBe(2);
    expect(next.published?.compiled['title']).toBe('停靠站点 v2');
    expect(where(again.problems)).toEqual([[ProblemCodes.definitionInvalid, '']]);
    expect(again.problems[0]!.message).toContain('下一个版本是 v2');
  });

  it('引用的静态数据定义版本不存在时拒绝发布', async () => {
    const { problems, published } = publishStaticSchema(await readDraft('schema-route-sign-v1.json'), []);

    expect(published).toBeUndefined();
    expect(where(problems)).toEqual([[ProblemCodes.definitionRefNotFound, 'stops.items']]);
    expect(problems[0]!.message).toContain('停靠站点 v1');
  });

  it('引用成环时拒绝编译（M32）', () => {
    const a = { ...definition([{ name: 'child', displayName: '子', type: 'ref', ref: { name: '乙', version: 1 } }], '甲'), version: 1 };
    const b = { ...definition([{ name: 'parent', displayName: '父', type: 'ref', ref: { name: '甲', version: 1 } }], '乙'), version: 1 };
    const entries: StaticSchemaEntry[] = [
      { ref: { name: '甲', version: 1 }, definition: a },
      { ref: { name: '乙', version: 1 }, definition: b },
    ];
    const { problems } = compileStaticSchema(entries[0]!, entries);

    expect(where(problems)).toEqual([[ProblemCodes.definitionRefCycle, 'child.parent']]);
    expect(problems[0]!.message).toContain('甲 v1 → 乙 v1 → 甲 v1');
  });

  it.each([
    ['最小长度大于最大长度', { type: 'text', constraints: { minLength: 5, maxLength: 2 } }, ProblemCodes.definitionConstraintConflict, 'f.constraints'],
    ['下界大于上界', { type: 'number', constraints: { min: 10, max: 1 } }, ProblemCodes.definitionConstraintConflict, 'f.constraints'],
    ['枚举值违反长度', { type: 'text', constraints: { enum: ['甲', '乙丙'], maxLength: 1 } }, ProblemCodes.definitionConstraintConflict, 'f.constraints'],
    ['枚举值违反正则', { type: 'text', constraints: { enum: ['甲', '乙'], pattern: '^甲' } }, ProblemCodes.definitionConstraintConflict, 'f.constraints'],
    ['枚举值超出范围', { type: 'number', constraints: { enum: [1, 20], max: 10 } }, ProblemCodes.definitionConstraintConflict, 'f.constraints'],
    ['范围内没有整数', { type: 'number', constraints: { integer: true, min: 0.2, max: 0.8 } }, ProblemCodes.definitionConstraintConflict, 'f.constraints'],
    ['最少项数大于最多项数', { type: 'list', items: { type: 'text' }, constraints: { minItems: 3, maxItems: 1 } }, ProblemCodes.definitionConstraintConflict, 'f.constraints'],
    ['约束不适用于该类型', { type: 'number', constraints: { minLength: 1 } }, ProblemCodes.definitionConstraintConflict, 'f.constraints'],
    ['列表元素单独设必填', { type: 'list', items: { type: 'text', constraints: { required: true } } }, ProblemCodes.definitionConstraintConflict, 'f.items.constraints'],
    ['列表嵌套列表', { type: 'list', items: { type: 'list', items: { type: 'text' } } }, ProblemCodes.definitionNestedList, 'f.items'],
    ['正则不合法', { type: 'text', constraints: { pattern: '(' } }, ProblemCodes.definitionInvalid, 'f.constraints'],
    ['图片来源不合法', { type: 'image', constraints: { allowedSources: ['ftp'] } }, ProblemCodes.definitionInvalid, 'f.constraints'],
    ['数值界限超过 15 位有效数字', { type: 'number', constraints: { max: 0.1234567890123456 } }, ProblemCodes.definitionInvalid, 'f.constraints'],
    ['未定义的属性', { type: 'text', width: 3 }, ProblemCodes.definitionUnknownProperty, 'f'],
  ])('约束检查：%s', (_label, field, code, path) => {
    const { problems } = publishStaticSchema(definition([{ name: 'f', displayName: '字段', ...field }]), []);
    expect(where(problems)).toEqual([[code, path]]);
  });

  it('字段名称必须是英文标识且不重复', () => {
    const dotted = publishStaticSchema(definition([{ name: 'stop.name', displayName: '站名', type: 'text' }]), []);
    const chinese = publishStaticSchema(definition([{ name: '站名', displayName: '站名', type: 'text' }]), []);
    const duplicate = publishStaticSchema(
      definition([
        { name: 'name', displayName: '站名', type: 'text' },
        { name: 'name', displayName: '又一个', type: 'text' },
      ]),
      [],
    );

    expect(where(dotted.problems)).toEqual([[ProblemCodes.definitionInvalid, 'fields[1]']]);
    expect(where(chinese.problems)).toEqual([[ProblemCodes.definitionInvalid, 'fields[1]']]);
    expect(where(duplicate.problems)).toEqual([[ProblemCodes.definitionInvalid, 'name']]);
  });

  it('命令行发布：写出带版本号的定义与编译产物，版本号接着工作区中已有的', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'renderweave-publish-'));
    const { version: _version, ...unversioned } = await readDraft('schema-stop-v1.json');
    const definitionFile = join(dir, 'schema-stop.json');
    await writeFile(definitionFile, JSON.stringify(unversioned));
    const out = join(dir, 'out');
    const stdout: string[] = [];
    const code = await runCli(['publish', '--definition', definitionFile, '--workspace', m402Dir, '--out', out], {
      stdout: (text) => stdout.push(text),
      stderr: () => undefined,
    });

    expect(code).toBe(ExitCodes.ok);
    expect(stdout.join('')).toContain('已发布：停靠站点 v2');
    expect(JSON.parse(await readFile(join(out, 'schema-stop-v2.json'), 'utf8')).version).toBe(2);
    expect(JSON.parse(await readFile(join(out, 'compiled-stop-v2.schema.json'), 'utf8')).title).toBe('停靠站点 v2');
  });
});

describe('数据集校验：全部字段类型与约束', () => {
  const allTypes = definition(
    [
      { name: 'title', displayName: '标题', type: 'text', constraints: { required: true, minLength: 1, maxLength: 4, pattern: '^[^0-9]*$' } },
      { name: 'grade', displayName: '等级', type: 'text', constraints: { enum: ['甲', '乙'] } },
      { name: 'price', displayName: '票价', type: 'number', constraints: { min: 0, max: 100 } },
      { name: 'count', displayName: '班次数', type: 'number', constraints: { integer: true } },
      { name: 'day', displayName: '日期', type: 'date' },
      { name: 'at', displayName: '时刻', type: 'time' },
      { name: 'stamp', displayName: '时间', type: 'datetime' },
      { name: 'open', displayName: '是否开通', type: 'boolean' },
      { name: 'logo', displayName: '标志', type: 'image', constraints: { allowedSources: ['resource'] } },
      { name: 'photo', displayName: '照片', type: 'image', constraints: { allowedSources: ['url'] } },
      { name: 'any', displayName: '任意图片', type: 'image' },
      { name: 'tags', displayName: '标签', type: 'list', items: { type: 'text', constraints: { maxLength: 2 } }, constraints: { minItems: 1, maxItems: 3 } },
      { name: 'stop', displayName: '首站', type: 'ref', ref: { name: '停靠站点', version: 1 } },
      { name: 'stops', displayName: '站点', type: 'list', items: { type: 'ref', ref: { name: '停靠站点', version: 1 } } },
    ],
    '全类型',
  );
  const valid = {
    title: '线路',
    grade: '甲',
    price: 2.5,
    count: 3,
    day: '2026-01-02',
    at: '07:30',
    stamp: '2025-01-02 09:08:12',
    open: true,
    logo: 'res:logo',
    photo: 'https://example.com/a.png',
    any: 'res:logo',
    tags: ['快线'],
    stop: { name: '东门', road: '深南路' },
    stops: [{ name: '田贝', road: '文锦路', landmark: 'res:landmark-1' }],
  };

  async function problemsFor(patch: Record<string, unknown>, remove: string[] = []): Promise<unknown[]> {
    const entries = publishAll([await readDraft('schema-stop-v1.json'), allTypes]);
    const workspace: Workspace = withEmptyTemplate(
      { staticSchemas: entries, templates: [], datasets: [], resources: imageOnlyResources(['logo', 'landmark-1'], ['font-x']), problems: [] },
      '全类型样例',
      { name: '全类型', version: 1 },
    );
    const data: Record<string, unknown> = { ...valid, ...patch };
    for (const key of remove) delete data[key];
    const result = await render(workspace, {
      template: '全类型样例',
      dataset: { inline: { dataset: { staticSchema: { name: '全类型', version: 1 } }, data } },
      output: { width: 10, height: 10, dpi: 72, format: 'png' },
      mode: 'final',
    });
    return where(result.problems);
  }

  it('合法的数据集没有问题', async () => {
    expect(await problemsFor({})).toEqual([]);
    expect(await problemsFor({ at: '07:30:15', any: 'https://example.com/b.jpg' })).toEqual([]);
  });

  it.each([
    ['日期不存在', { day: '2026-02-30' }, ProblemCodes.datasetFormatInvalid, 'day'],
    ['日期写法不对（只报一次）', { day: '2026-1-2' }, ProblemCodes.datasetFormatInvalid, 'day'],
    ['时刻越界', { at: '24:00' }, ProblemCodes.datasetFormatInvalid, 'at'],
    ['时间带了 T 分隔', { stamp: '2025-01-02T09:08:12' }, ProblemCodes.datasetFormatInvalid, 'stamp'],
    ['布尔写成文本', { open: 'true' }, ProblemCodes.datasetTypeMismatch, 'open'],
    ['数值超过上界', { price: 100.5 }, ProblemCodes.datasetConstraintViolated, 'price'],
    ['数值有效数字过多', { price: 0.1 + 0.2 }, ProblemCodes.datasetTooManyDigits, 'price'],
    ['整数写成小数', { count: 2.5 }, ProblemCodes.datasetTypeMismatch, 'count'],
    ['不在枚举中', { grade: '丙' }, ProblemCodes.datasetConstraintViolated, 'grade'],
    ['不满足正则', { title: 'A1' }, ProblemCodes.datasetFormatInvalid, 'title'],
    ['只允许资源引用却写了 URL', { logo: 'https://example.com/a.png' }, ProblemCodes.datasetFormatInvalid, 'logo'],
    ['只允许 URL 却写了资源引用', { photo: 'res:logo' }, ProblemCodes.datasetFormatInvalid, 'photo'],
    ['URL 不是 http 或 https', { photo: 'ftp://example.com/a.png' }, ProblemCodes.datasetFormatInvalid, 'photo'],
    ['资源不存在', { logo: 'res:missing' }, ProblemCodes.datasetResourceNotFound, 'logo'],
    ['引用了字体资源', { logo: 'res:font-x' }, ProblemCodes.datasetResourceKindMismatch, 'logo'],
    ['列表项数不足', { tags: [] }, ProblemCodes.datasetConstraintViolated, 'tags'],
    ['列表元素超长', { tags: ['快线', '太长了'] }, ProblemCodes.datasetConstraintViolated, 'tags[2]'],
    ['引用中缺必填字段', { stop: { name: '东门' } }, ProblemCodes.datasetRequiredMissing, 'stop.road'],
    ['列表中引用的资源不存在', { stops: [{ name: '田贝', road: '文锦路', landmark: 'res:missing' }] }, ProblemCodes.datasetResourceNotFound, 'stops[1].landmark'],
    ['写成 null', { title: null }, ProblemCodes.datasetNullValue, 'title'],
    ['未定义的键', { extra: 1 }, ProblemCodes.datasetUnknownKey, 'extra'],
  ])('%s', async (_label, patch, code, path) => {
    expect(await problemsFor(patch)).toEqual([[code, path]]);
  });

  it('必填字段缺失', async () => {
    expect(await problemsFor({}, ['title'])).toEqual([[ProblemCodes.datasetRequiredMissing, 'title']]);
  });
});

describe('数据集版本与模板基准', () => {
  it('不一致时报严重问题，两种模式都不出图（M37、M102）', async () => {
    const workspace = await loadSingleText();
    const v1 = workspace.staticSchemas.find((entry) => entry.ref.name === '问候')!;
    const { version: _version, ...unversioned } = v1.definition as Record<string, unknown>;
    const v2 = publishStaticSchema(unversioned, workspace.staticSchemas).published!;
    const withV2: Workspace = { ...workspace, staticSchemas: [...workspace.staticSchemas, v2] };
    const request = (mode: string) => ({
      template: '问候牌',
      dataset: { inline: { dataset: { staticSchema: { name: '问候', version: 2 } }, data: { message: '你好' } } },
      output: { width: 160, height: 40, dpi: 120, format: 'png' },
      mode,
    });
    const final = await render(withV2, request('final'));
    const draft = await render(withV2, request('draft'));

    expect(final.problems.map((p) => [p.code, p.level, p.location])).toEqual([
      [ProblemCodes.datasetStaticSchemaMismatch, 'severe', { kind: 'input', source: 'dataset.staticSchema' }],
      [ProblemCodes.renderExpansionBlocked, 'severe', { kind: 'input', source: 'render' }],
    ]);
    expect(final.problems[0]!.message).toBe('数据集选定的是"问候 v2"，模板"问候牌"的基准是"问候 v1"');
    expect(final.image).toBeUndefined();
    expect(final.layout).toBeUndefined();
    expect(draft.image).toBeUndefined();
  });
});

describe('M402 数据集', () => {
  it('按编译产物校验没有问题', async () => {
    const workspace = withEmptyTemplate(
      { ...(await loadWorkspace({ dir: m402Dir, resourcesDir })), resources: imageOnlyResources(M402_IMAGE_IDS) },
      '只看数据',
      { name: '线路牌', version: 1 },
    );
    const result = await render(workspace, {
      template: '只看数据',
      dataset: { id: 'ds-m402-wanguocheng' },
      output: { width: 10, height: 10, dpi: 72, format: 'png' },
      mode: 'final',
    });

    expect(workspace.problems).toEqual([]);
    expect(result.problems).toEqual([]);
  });
});

describe('工作区中的编译产物都由发布生成（M103）', () => {
  it.each([
    ['M402 DSL 草稿', m402Dir],
    ['单个文本字段', singleTextDir],
    ['竖排站名', stopNameDir],
    ['M402 版式骨架', skeletonDir],
  ])('%s', async (_label, dir) => {
    const workspace = await loadWorkspace({ dir, resourcesDir });
    for (const entry of workspace.staticSchemas) {
      expect(entry.definition, `${entry.ref.name} v${entry.ref.version} 缺少数据定义`).toBeDefined();
      expect(entry.compiled, `${entry.ref.name} v${entry.ref.version} 缺少编译产物`).toBeDefined();
      const { compiled, problems } = compileStaticSchema(entry, workspace.staticSchemas);
      expect(problems).toEqual([]);
      expect(compiled).toEqual(entry.compiled);
    }
  });
});

describe('数值精度（M112）', () => {
  it('工作区中的数据集写了超过 15 位有效数字的数值时报问题', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'renderweave-digits-'));
    await writeFile(
      join(dir, 'dataset-digits.json'),
      '{ "dataset": { "id": "ds-digits", "staticSchema": { "name": "全类型", "version": 1 } }, "data": { "price": 1.000000000000000000001 } }',
    );
    const workspace = await loadWorkspace({ dir, resourcesDir: join(repoRoot, 'fixtures', 'resources') });

    expect(workspace.problems.map((p) => p.code)).toEqual([ProblemCodes.datasetTooManyDigits]);
    expect(workspace.problems[0]!.message).toContain('1.000000000000000000001');
  });
});
