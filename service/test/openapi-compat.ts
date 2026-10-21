/**
 * 开放 API 的兼容检查（票据 11，docs/api.md「兼容策略」）：比较两份 OpenAPI 描述，列出不是"只做加法"的改动。
 * - 端点：不能删；访问要求不能变；
 * - 请求：能接受的不能变少——不能新增必填的参数与属性，不能删属性（封闭的对象），类型、枚举、取值范围与写法不能收窄；
 * - 成功回答：承诺的不能变少——状态与媒体类型不能删，属性不能删，必有的属性不能变成可有可无，类型不能放宽、const 与格式不能变；
 *   新增属性、新增枚举值、新增可选的分支不算不兼容（客户端应忽略不认识的属性与枚举值）；
 * - webhook 的事件正文按回答比较；错误回答只要求仍是问题清单，新增错误状态不算不兼容。
 */
type Json = Record<string, any>;

/** 解析 $ref：#/components/schemas/X 在整份描述里找；#/$defs/X 在最近的带 $id 的 Schema 里找。 */
interface Context { readonly doc: Json; readonly root: Json }
function resolve(schema: unknown, context: Context): { schema: Json; context: Context } {
  let current = schema as Json, ctx = context;
  for (let guard = 0; current && typeof current === 'object' && typeof current['$ref'] === 'string' && guard < 20; guard++) {
    const target = current['$ref'] as string;
    const base = target.startsWith('#/components/') ? ctx.doc : ctx.root;
    const found = target.slice(2).split('/').reduce<any>((node, part) => node?.[part.replace(/~1/g, '/').replace(/~0/g, '~')], base);
    if (found === undefined) throw new Error(`引用找不到：${target}`);
    current = found;
    if (typeof found['$id'] === 'string') ctx = { doc: ctx.doc, root: found };
  }
  if (current && typeof current === 'object' && typeof current['$id'] === 'string') ctx = { doc: ctx.doc, root: current };
  return { schema: current, context: ctx };
}

const types = (schema: Json): Set<string> | undefined => {
  if (schema['const'] !== undefined) return undefined;
  const type = schema['type'];
  return type === undefined ? undefined : new Set(([] as string[]).concat(type).flatMap((t) => (t === 'number' ? ['number', 'integer'] : [t])));
};
const values = (schema: Json): unknown[] | undefined => (schema['const'] !== undefined ? [schema['const']] : schema['enum']);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const BRANCHES = ['oneOf', 'anyOf'] as const;
/** 比过的 Schema 对：引用成环时不重复比较。 */
type Seen = Map<object, Set<object>>;
function visited(seen: Seen, x: object, y: object): boolean {
  const pairs = seen.get(x) ?? new Set<object>();
  if (pairs.has(y)) return true;
  seen.set(x, pairs.add(y));
  return false;
}
const copy = (seen: Seen): Seen => new Map([...seen].map(([x, ys]) => [x, new Set(ys)]));

/** 请求一侧：after 要接受 before 接受的一切。 */
function narrowed(before: unknown, after: unknown, at: string, b: Context, a: Context, seen: Seen): string[] {
  const left = resolve(before, b), right = resolve(after, a);
  const x = left.schema, y = right.schema;
  if (x === undefined || y === undefined || x === y) return [];
  if (visited(seen, x, y)) return [];
  const out: string[] = [];
  const tx = types(x), ty = types(y);
  if (ty && (!tx || [...tx].some((t) => !ty.has(t)))) out.push(`${at}：类型收窄（${[...(tx ?? ['任意'])].join('|')} → ${[...ty].join('|')}）`);
  const vx = values(x), vy = values(y);
  if (vy && (!vx || vx.some((v) => !vy.some((w) => same(v, w))))) out.push(`${at}：可选的取值变少`);
  for (const [key, larger] of [['minimum', true], ['exclusiveMinimum', true], ['minLength', true], ['minItems', true], ['minProperties', true],
    ['maximum', false], ['exclusiveMaximum', false], ['maxLength', false], ['maxItems', false]] as const) {
    if (y[key] === undefined) continue;
    if (x[key] === undefined || (larger ? y[key] > x[key] : y[key] < x[key])) out.push(`${at}：${key} 收紧`);
  }
  if (y['pattern'] !== undefined && y['pattern'] !== x['pattern']) out.push(`${at}：pattern 改变`);
  if (y['uniqueItems'] === true && x['uniqueItems'] !== true) out.push(`${at}：新要求不重复`);
  const required = new Set<string>(x['required'] ?? []);
  for (const name of y['required'] ?? []) if (!required.has(name)) out.push(`${at}：新增必填 ${name}`);
  const props = (y['properties'] ?? {}) as Json;
  for (const [name, schema] of Object.entries((x['properties'] ?? {}) as Json)) {
    if (props[name] !== undefined) out.push(...narrowed(schema, props[name], `${at}.${name}`, left.context, right.context, seen));
    else if (y['additionalProperties'] === false) out.push(`${at}：不再接受 ${name}`);
  }
  if (y['additionalProperties'] === false && x['additionalProperties'] !== false) out.push(`${at}：不再接受未列出的属性`);
  if (x['items'] !== undefined && y['items'] !== undefined) out.push(...narrowed(x['items'], y['items'], `${at}[]`, left.context, right.context, seen));
  for (const keyword of BRANCHES) {
    for (const [i, branch] of ((x[keyword] ?? []) as unknown[]).entries()) {
      const candidates = (y[keyword] ?? []) as unknown[];
      if (!candidates.some((candidate) => !narrowed(branch, candidate, `${at}/${keyword}`, left.context, right.context, copy(seen)).length)) {
        out.push(`${at}：${keyword} 的第 ${i + 1} 种写法不再被接受`);
      }
    }
  }
  return out;
}

/** 回答一侧：after 仍要兑现 before 承诺的一切。 */
function weakened(before: unknown, after: unknown, at: string, b: Context, a: Context, seen: Seen): string[] {
  const left = resolve(before, b), right = resolve(after, a);
  const x = left.schema, y = right.schema;
  if (x === undefined || y === undefined || x === y) return [];
  if (visited(seen, x, y)) return [];
  const out: string[] = [];
  const tx = types(x), ty = types(y);
  if (tx && (!ty || [...ty].some((t) => !tx.has(t)))) out.push(`${at}：类型放宽（${[...tx].join('|')} → ${[...(ty ?? ['任意'])].join('|')}）`);
  if (x['const'] !== undefined && !same(x['const'], y['const'])) out.push(`${at}：const 改变`);
  if (x['format'] !== undefined && x['format'] !== y['format']) out.push(`${at}：格式改变`);
  const required = new Set<string>(y['required'] ?? []);
  for (const name of x['required'] ?? []) if (!required.has(name)) out.push(`${at}：${name} 不再必有`);
  const props = (y['properties'] ?? {}) as Json;
  for (const [name, schema] of Object.entries((x['properties'] ?? {}) as Json)) {
    if (props[name] === undefined) out.push(`${at}：删除了属性 ${name}`);
    else out.push(...weakened(schema, props[name], `${at}.${name}`, left.context, right.context, seen));
  }
  if (x['items'] !== undefined) out.push(...(y['items'] === undefined ? [`${at}：删除了 items`] : weakened(x['items'], y['items'], `${at}[]`, left.context, right.context, seen)));
  for (const keyword of BRANCHES) {
    for (const [i, branch] of ((x[keyword] ?? []) as unknown[]).entries()) {
      const candidates = (y[keyword] ?? []) as unknown[];
      if (!candidates.some((candidate) => !weakened(branch, candidate, `${at}/${keyword}`, left.context, right.context, copy(seen)).length)) {
        out.push(`${at}：${keyword} 的第 ${i + 1} 种形状不再有`);
      }
    }
  }
  return out;
}

const METHODS = ['get', 'put', 'post', 'patch', 'delete'];

/** before 到 after 不是"只做加法"的改动；空表示兼容。 */
export function breakingChanges(before: Json, after: Json): string[] {
  const b: Context = { doc: before, root: before }, a: Context = { doc: after, root: after };
  const out: string[] = [];
  for (const [path, item] of Object.entries(before['paths'] ?? {}) as [string, Json][]) {
    for (const method of METHODS) {
      const old = item[method] as Json | undefined;
      if (!old) continue;
      const at = `${method.toUpperCase()} ${path}`, now = after['paths']?.[path]?.[method] as Json | undefined;
      if (!now) { out.push(`${at}：端点被删除`); continue; }
      if (old['x-access'] !== now['x-access']) out.push(`${at}：访问要求从 ${old['x-access']} 改为 ${now['x-access']}`);
      const params = new Map(((now['parameters'] ?? []) as Json[]).map((p) => [`${p['in']}:${p['name']}`, p]));
      const oldParams = new Map(((old['parameters'] ?? []) as Json[]).map((p) => [`${p['in']}:${p['name']}`, p]));
      for (const [key, param] of oldParams) {
        const next = params.get(key);
        if (!next) out.push(`${at}：参数 ${key} 被删除`);
        else out.push(...narrowed(param['schema'], next['schema'], `${at} 参数 ${key}`, b, a, new Map()));
      }
      for (const [key, param] of params) if (param['required'] && !oldParams.get(key)?.['required']) out.push(`${at}：新增必填参数 ${key}`);
      const oldBody = old['requestBody'] as Json | undefined, newBody = now['requestBody'] as Json | undefined;
      if (!oldBody && newBody?.['required']) out.push(`${at}：新要求请求体`);
      for (const [type, content] of Object.entries((oldBody?.['content'] ?? {}) as Json)) {
        const next = newBody?.['content']?.[type];
        if (!next) out.push(`${at}：不再接受 ${type} 的请求体`);
        else out.push(...narrowed(content['schema'], next['schema'], `${at} 请求体`, b, a, new Map()));
      }
      for (const [status, response] of Object.entries((old['responses'] ?? {}) as Json)) {
        if (!status.startsWith('2')) continue;
        const next = now['responses']?.[status] as Json | undefined;
        if (!next) { out.push(`${at}：不再回答 ${status}`); continue; }
        for (const [type, content] of Object.entries((response['content'] ?? {}) as Json)) {
          const replaced = next['content']?.[type];
          if (!replaced) out.push(`${at} ${status}：不再回答 ${type}`);
          else out.push(...weakened(content['schema'], replaced['schema'], `${at} ${status}`, b, a, new Map()));
        }
      }
    }
  }
  for (const [name, item] of Object.entries(before['webhooks'] ?? {}) as [string, Json][]) {
    const next = after['webhooks']?.[name] as Json | undefined;
    if (!next) { out.push(`webhook ${name}：事件被删除`); continue; }
    out.push(...weakened(item['post']?.['requestBody']?.['content']?.['application/json']?.['schema'], next['post']?.['requestBody']?.['content']?.['application/json']?.['schema'],
      `webhook ${name} 正文`, b, a, new Map()));
  }
  return out;
}
