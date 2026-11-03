/** 原型只调用引擎公开入口；不复制类型/约束校验。 */
import { readFile, writeFile } from 'node:fs/promises';
import { checkDataset, createMemoryResourceRepository, publishStaticSchema, type StaticSchemaEntry } from '../../../src/index.js';

const definitions = [
  { dslVersion: 'renderweave-schema/1', name: 'prototype-stop', displayName: '原型停靠项', fields: [
    { name: 'name', displayName: '站名', type: 'text', constraints: { required: true, minLength: 1 } },
    { name: 'code', displayName: '编码', type: 'text', constraints: { required: true, minLength: 1 } },
    { name: 'weekdayTimes', displayName: '工作日班时', type: 'list', items: { type: 'time' }, constraints: { required: true } },
    { name: 'fridayTimes', displayName: '周五班时', type: 'list', items: { type: 'time' }, constraints: { required: true } },
  ] },
  { dslVersion: 'renderweave-schema/1', name: 'prototype-route', displayName: '原型线路方向', fields: [
    { name: 'lineName', displayName: '线路', type: 'text', constraints: { required: true } },
    { name: 'direction', displayName: '方向', type: 'text', constraints: { required: true } },
    { name: 'stops', displayName: '停靠列表', type: 'list', items: { type: 'ref', ref: { name: 'prototype-stop', version: 1 } }, constraints: { required: true, minItems: 1 } },
  ] },
];
const staticSchemas: StaticSchemaEntry[] = [];
for (const definition of definitions) {
  const result = publishStaticSchema(definition, staticSchemas);
  if (!result.published || result.problems.length) throw new Error(JSON.stringify(result.problems));
  staticSchemas.push(result.published);
}
const candidate = JSON.parse(await readFile(process.argv[2]!, 'utf8')) as { datasets: unknown[] };
if (!Array.isArray(candidate.datasets) || candidate.datasets.length === 0) throw new Error('缺少候选数据集');
const results = candidate.datasets.map(dataset => checkDataset(Buffer.from(JSON.stringify(dataset)), {
  staticSchemas, resources: createMemoryResourceRepository([]),
}));
const passed = results.every(result => !result.problems.some(p => p.level === 'severe'));
await writeFile(process.argv[3]!, JSON.stringify({ format: 'rw-excel-engine-prototype/1', passed, results }, null, 2), { flag: 'wx' });
process.exitCode = passed ? 0 : 2;
