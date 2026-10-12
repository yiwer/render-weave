/** 内置静态数据定义：空数据定义与七种基本字段类型的单值包装（M20、S9）。 */
import type { StaticSchemaEntry, StaticSchemaRef, Workspace } from '../workspace.js';
import { DATE_PATTERN, DATETIME_PATTERN, RESOURCE_OR_URL_PATTERN, TIME_PATTERN } from './formats.js';

const SINGLE_FIELDS: Readonly<Record<string, Record<string, unknown>>> = {
  文本: { type: 'string' },
  数值: { type: 'number' },
  日期: { type: 'string', format: 'date', pattern: DATE_PATTERN, 'x-renderweave-type': 'date' },
  时刻: { type: 'string', format: 'rw-time', pattern: TIME_PATTERN, 'x-renderweave-type': 'time' },
  时间: { type: 'string', format: 'rw-datetime', pattern: DATETIME_PATTERN, 'x-renderweave-type': 'datetime' },
  布尔: { type: 'boolean' },
  图片: { type: 'string', pattern: RESOURCE_OR_URL_PATTERN, 'x-renderweave-type': 'image' },
};

/** 固定的内置编译产物；渲染时不调用数据定义编译器。内置名称保留，不能被工作区覆盖。 */
export function findStaticSchema(workspace: Pick<Workspace, 'staticSchemas'>, ref: StaticSchemaRef): StaticSchemaEntry | undefined {
  const single = ref.name.startsWith('单值·') && Object.hasOwn(SINGLE_FIELDS, ref.name.slice(3)) ? SINGLE_FIELDS[ref.name.slice(3)] : undefined;
  if (ref.name === '空数据定义' || single) {
    if (ref.version !== 1) return undefined;
    return {
      ref,
      compiled: {
        $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object',
        'x-renderweave-static-schema': ref,
        properties: single ? { value: single } : {},
        required: single ? ['value'] : [], additionalProperties: false,
      },
    };
  }
  return workspace.staticSchemas.find((entry) => entry.ref.name === ref.name && entry.ref.version === ref.version);
}
