/**
 * 数据定义（P1 票据 01）：模块下拉里的第一个模块，先只读列出本租户已发布的静态数据定义与用到它们的模板、数据集。
 * 草案、详情与发布记录三页在 P1 票据 06 做；在那之前数据定义由代建工程师推送（M264）。
 */
import { api } from '../api.js';
import { ErrorBox } from '../components/problems.js';
import { useLoad } from '../hooks.js';
import type { StaticSchemaSummary } from '../types.js';
import { sameSchema } from './templates.js';

export function DefinitionList() {
  const loaded = useLoad(async () => {
    const [schemas, templates, datasets] = await Promise.all([api.staticSchemas(), api.templates(), api.datasets()]);
    return { schemas: schemas.staticSchemas, templates: templates.templates, datasets: datasets.datasets };
  }, 'definitions');
  const { data } = loaded;
  // 一个名称一行：版本从旧到新排好（GET /v1/static-schemas 按名称、版本排序），最后一个是当前版本。
  const names = new Map<string, StaticSchemaSummary[]>();
  for (const schema of data?.schemas ?? []) names.set(schema.name, [...(names.get(schema.name) ?? []), schema]);
  return (
    <section className="page">
      <div className="title-row">
        <div>
          <h1>数据定义</h1>
          <p className="lede">数据定义规定一份数据有哪些字段、各是什么类型。发布出来的每个版本都不再改变，模板与数据集按名称和版本使用它。</p>
        </div>
      </div>
      <ErrorBox problems={loaded.problems} title="读不到数据定义" />
      {loaded.loading && !data && <p className="muted">正在读取…</p>}
      {data && (
        <div className="card">
          <table className="table">
            <thead><tr><th>名称</th><th>版本</th><th>模板</th><th>数据集</th></tr></thead>
            <tbody>
              {names.size === 0 && <tr><td colSpan={4} className="muted">还没有数据定义。</td></tr>}
              {[...names].map(([name, versions]) => {
                const latest = versions.at(-1)!;
                const uses = (ref: { readonly name: string; readonly version: number } | undefined) => versions.some((version) => sameSchema(version, ref));
                const templates = data.templates.filter((template) => uses(template.base));
                return (
                  <tr key={name} data-testid="definition-row" data-name={name}>
                    <td>
                      <strong>{latest.displayName}</strong>
                      {latest.displayName !== name && <div className="mono muted">{name}</div>}
                      {latest.description && <div className="small muted">{latest.description}</div>}
                    </td>
                    <td>{versions.map((version) => `v${version.version}`).join('、')}</td>
                    <td>{templates.length ? templates.map((template) => template.name).join('、') : <span className="muted">没有</span>}</td>
                    <td>{data.datasets.filter((dataset) => uses(dataset.staticSchema)).length.toLocaleString('zh-CN')} 份</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="small faint">在网页上改结构与发布新版本随后提供；现在由代建工程师推送。</p>
    </section>
  );
}
