/** 公开 DSL 参考仅有这一份来源映射；受管轮次由宿主保存完整字节后交给只读服务。 */
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
export const REFERENCE_FILES = {
  'reference/data-definition':'agent/reference/data-definition.md','reference/template':'agent/reference/template.md',
  'schema/data-definition':'schemas/data-definition.schema.json','schema/dataset':'schemas/dataset.schema.json','schema/template':'schemas/template.schema.json',
  'schema/render-request':'schemas/render-request.schema.json','schema/batch-request':'schemas/batch-request.schema.json',
} as const;
export type ReferenceTexts=Readonly<Record<keyof typeof REFERENCE_FILES,string>>;
export async function referenceTexts(bundle?:string):Promise<ReferenceTexts>{
  if(bundle){
    const value=JSON.parse(await readFile(bundle,'utf8'));
    if(value.format!=='renderweave-reference-materials/1'||!value.texts||Object.keys(value.texts).length!==Object.keys(REFERENCE_FILES).length||Object.keys(REFERENCE_FILES).some(name=>typeof value.texts[name]!=='string'))throw new Error('固定 DSL 参考资料不完整');
    return value.texts;
  }
  const root=fileURLToPath(new URL('../../',import.meta.url));
  return Object.fromEntries(await Promise.all(Object.entries(REFERENCE_FILES).map(async([name,path])=>[name,await readFile(join(root,path),'utf8')])) ) as unknown as ReferenceTexts;
}
