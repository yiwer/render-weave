/**
 * 模板：列表（缩略预览、适用尺寸范围、对应的数据定义）与只读预览（参数面板调对外参数，看草稿预览）。
 * 操作员只读；缩略预览用同一数据定义的第一份数据集，没有就用空白数据，草稿里显示占位。
 * 客户管理员（P1 票据 08、09）从这里进模板设计与发布修订，也能把模板复制成新模板；还没保存的新模板只有工作副本，单独列出。
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { defaultOutput, defaultParameters, OutputPanel, ParameterPanel, rangeText, type ParameterValues } from '../components/parameters.js';
import { PreviewCanvas } from '../components/preview-canvas.js';
import { ErrorBox, ProblemList } from '../components/problems.js';
import { go, href, problemsOf, queuePreview, useLivePreview, useLoad } from '../hooks.js';
import type { DatasetEntry, Identity, OutputSettings, Problem, SchemaRef, StaticSchemaSummary, TemplateInfo, TemplateWorkingCopy } from '../types.js';
import { Loading } from '../components/motifs.js';

export const sameSchema = (a: SchemaRef | undefined, b: SchemaRef | undefined) => Boolean(a && b && a.name === b.name && a.version === b.version);

export function schemaText(ref: SchemaRef | undefined, schemas: readonly StaticSchemaSummary[] = []): string {
  if (!ref) return '—';
  const found = schemas.find((schema) => sameSchema(schema, ref));
  return found && found.displayName !== ref.name ? `${found.displayName}（${ref.name} v${ref.version}）` : `${ref.name} v${ref.version}`;
}

/** 预览请求里的数据集：已保存的按 ID，否则是只选了数据定义的空白数据。 */
export function datasetRef(base: SchemaRef, datasetId: string | undefined): unknown {
  return datasetId ? { id: datasetId } : { inline: { dataset: { staticSchema: base }, data: {} } };
}

const thumbnails = new Map<string, string>();

function Thumbnail(props: { readonly template: TemplateInfo; readonly dataset?: DatasetEntry }) {
  const { template, dataset } = props;
  const key = `${template.name}@${template.currentRevision}:${dataset?.sha256 ?? '空白'}`;
  const [url, setUrl] = useState(thumbnails.get(key));
  useEffect(() => {
    const cached = thumbnails.get(key);
    if (cached || !template.base || !template.sizeRange) { setUrl(cached); return undefined; }
    let live = true;
    // 缩略图约 720 像素宽：按最长边定 DPI。缩略图只看样子，问题以正式尺寸的预览为准。
    const { width, height } = template.sizeRange, longest = Math.max(width.min, height.min);
    const dpi = Math.min(150, Math.max(30, Math.round((720 * 25.4) / longest)));
    const request = { template: template.name, dataset: datasetRef(template.base, dataset?.id), parameters: defaultParameters(template), output: { width: width.min, height: height.min, dpi, format: 'png' } };
    queuePreview(request, () => !live).then((reply) => {
      if (!reply?.image) return;
      const value = `data:image/png;base64,${reply.image.base64}`;
      thumbnails.set(key, value);
      if (live) setUrl(value);
    }, () => undefined);
    return () => { live = false; };
  }, [key, template, dataset]);
  return (
    <div className="thumbnail">
      {url ? <img src={url} alt={`${template.name} 的缩略预览`} /> : <span className="muted">{template.base ? '正在出缩略预览…' : '没有预览'}</span>}
    </div>
  );
}

/** 复制成新模板：内容与基准数据定义取当前修订，成为没有基准修订的工作副本，打开设计继续改。 */
function CopyTemplate(props: { readonly name: string }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<readonly Problem[]>();
  const copy = async () => {
    setBusy(true);
    setProblems(undefined);
    try {
      const created = await api.copyTemplate(props.name, name.trim());
      go(['templates', created.name, 'design']);
    } catch (error) { setProblems(problemsOf(error)); }
    finally { setBusy(false); }
  };
  if (!open) return <button type="button" className="small quiet" onClick={() => setOpen(true)}>复制为新模板</button>;
  return (
    <form className="inline-form copy-form" aria-label={`复制 ${props.name}`} onSubmit={(event) => { event.preventDefault(); if (name.trim()) void copy(); }}>
      <div className="field grow">
        <label htmlFor={`copy-${props.name}`}>新模板名称</label>
        <input id={`copy-${props.name}`} type="text" autoFocus maxLength={200} value={name} onChange={(event) => setName(event.target.value)} />
      </div>
      <button type="submit" className="small" disabled={!name.trim() || busy}>{busy ? '正在复制…' : '复制'}</button>
      <button type="button" className="small quiet" onClick={() => setOpen(false)}>取消</button>
      <ErrorBox problems={problems} title="没有复制" />
    </form>
  );
}

export function TemplateList(props: { readonly identity: Identity }) {
  const admin = props.identity.role === 'admin';
  const loaded = useLoad(async () => {
    const [templates, schemas, datasets, copies] = await Promise.all([api.templates(), api.staticSchemas(), api.datasets(), api.workingCopies()]);
    return { templates: templates.templates, schemas: schemas.staticSchemas, datasets: datasets.datasets, copies: copies.workingCopies };
  }, 'templates');
  const { data } = loaded;
  const copyOf = (name: string): TemplateWorkingCopy | undefined => data?.copies.find((copy) => copy.name === name);
  const newTemplates = data?.copies.filter((copy) => !data.templates.some((template) => template.name === copy.name)) ?? [];
  return (
    <section className="page">
      <div className="title-row">
        <div>
          <h1>模板</h1>
          <p className="lede">{admin
            ? '点开设计改位置、文字、颜色与参数，改动先暂存在工作副本里，看过差异与对比再发布为新修订；出图一直读当前修订。'
            : '本租户的模板由管理员与 RenderWeave 团队维护，这里只读。可以调对外参数看草稿预览，或者按模板的数据定义新建数据集。'}</p>
        </div>
      </div>
      <ErrorBox problems={loaded.problems} title="读不到模板" />
      {loaded.loading && !data && <Loading />}
      {data?.templates.length === 0 && newTemplates.length === 0 && <p className="muted">还没有模板。模板由代建团队推送到本租户后出现在这里。</p>}
      {newTemplates.length > 0 && (
        <div className="card new-templates">
          <table className="table">
            <thead><tr><th>还没保存的新模板</th><th>最后暂存</th><th><span className="visually-hidden">操作</span></th></tr></thead>
            <tbody>
              {newTemplates.map((copy) => (
                <tr key={copy.name} data-testid="new-template-row" data-name={copy.name}>
                  <td>{copy.name}</td>
                  <td>{copy.updatedBy} · {new Date(copy.updatedAt).toLocaleString('zh-CN')}</td>
                  <td className="row-actions">{admin && <a className="button small quiet" href={href(['templates', copy.name, 'design'])}>继续设计</a>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="card-grid">
        {data?.templates.map((template) => {
          const sample = data.datasets.find((entry) => sameSchema(entry.staticSchema, template.base));
          return (
            <article className="card template-card" key={template.name} aria-label={`模板 ${template.name}`}>
              <Thumbnail template={template} {...(sample ? { dataset: sample } : {})} />
              <div className="template-body">
                <h2>{template.name}</h2>
                {template.problems ? (
                  <ProblemList problems={template.problems} label="模板的问题" />
                ) : (
                  <dl className="facts">
                    <dt>适用尺寸</dt><dd>{template.sizeRange ? rangeText(template.sizeRange) : '—'}</dd>
                    <dt>数据定义</dt><dd>{schemaText(template.base, data.schemas)}</dd>
                    <dt>对外参数</dt><dd>{template.parameters?.length ? template.parameters.map((parameter) => parameter.displayName).join('、') : '无'}</dd>
                    {copyOf(template.name) && <><dt>工作副本</dt><dd><span className="chip accent" data-testid="working-copy-state">基于修订 {copyOf(template.name)!.baseRevision ?? '—'}，未发布</span></dd></>}
                  </dl>
                )}
                {!template.problems && (
                  <div className="actions" style={{ marginTop: 'auto' }}>
                    {admin && <a className="button primary small" href={href(['templates', template.name, 'design'])}>设计</a>}
                    <a className={`button small ${admin ? 'quiet' : 'primary'}`} href={href(['templates', template.name])}>预览与调参</a>
                    <a className="button quiet small" href={href(['templates', template.name, 'publish'])}>{admin && copyOf(template.name) ? '发布修订' : '修订历史'}</a>
                    {/* 引擎内置的数据定义（如单值文本）只给子模板用，不能新建数据集。 */}
                    {data.schemas.some((schema) => sameSchema(schema, template.base)) && (
                      <a className="button quiet small" href={href(['datasets', 'new'], { template: template.name })}>用它新建数据集</a>
                    )}
                    {admin && <CopyTemplate name={template.name} />}
                  </div>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

export function TemplateStudio(props: { readonly name: string; readonly identity: Identity }) {
  const loaded = useLoad(async () => {
    const [template, schemas, datasets] = await Promise.all([api.template(props.name), api.staticSchemas(), api.datasets()]);
    return { template, schemas: schemas.staticSchemas, datasets: datasets.datasets.filter((entry) => sameSchema(entry.staticSchema, template.base)) };
  }, props.name);
  const data = loaded.data;
  return (
    <section className="page">
      <nav className="crumbs" aria-label="位置"><a href={href(['templates'])}>模板</a><span aria-hidden="true">/</span><span>{props.name}</span></nav>
      <div className="title-row">
        <div>
          <h1>{props.name}</h1>
          {data && <div className="meta"><span>{props.identity.role === 'admin' ? `当前修订 ${data.template.currentRevision}` : '只读模板'}</span><span>数据定义 {schemaText(data.template.base, data.schemas)}</span>{data.template.sizeRange && <span>适用尺寸 {rangeText(data.template.sizeRange)}</span>}</div>}
        </div>
        <div className="actions">
          {props.identity.role === 'admin' && <a className="button primary" href={href(['templates', props.name, 'design'])}>设计</a>}
          <a className="button quiet" href={href(['templates', props.name, 'publish'])}>修订历史</a>
        </div>
      </div>
      <ErrorBox problems={loaded.problems} title="读不到模板" />
      {data && (data.template.problems ? <ProblemList problems={data.template.problems} label="模板的问题" />
        : <Studio template={data.template} datasets={data.datasets} canCreate={data.schemas.some((schema) => sameSchema(schema, data.template.base))} />)}
    </section>
  );
}

function Studio(props: { readonly template: TemplateInfo; readonly datasets: readonly DatasetEntry[]; readonly canCreate: boolean }) {
  const { template } = props;
  const [parameters, setParameters] = useState<ParameterValues>(() => defaultParameters(template));
  const [output, setOutput] = useState<OutputSettings>(() => defaultOutput(template));
  const [datasetId, setDatasetId] = useState(props.datasets[0]?.id ?? '');
  const request = useMemo(() => (template.base
    ? { template: template.name, dataset: datasetRef(template.base, datasetId || undefined), parameters, output } : undefined), [template, datasetId, parameters, output]);
  const preview = useLivePreview(request, 400);
  const names = useMemo(() => new Map((template.parameters ?? []).map((parameter) => [parameter.name, parameter.displayName])), [template]);
  return (
    <div className="columns">
      <aside className="col-side" style={{ flex: '1 1 340px', maxWidth: 420 }}>
        <section className="card" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="field">
            <label htmlFor="studio-dataset">预览用的数据</label>
            <select id="studio-dataset" value={datasetId} onChange={(event) => setDatasetId(event.target.value)}>
              {props.datasets.map((entry) => <option key={entry.id} value={entry.id}>{entry.name ? `${entry.name}（${entry.id}）` : entry.id}</option>)}
              <option value="">空白数据（显示占位）</option>
            </select>
          </div>
          <ParameterPanel template={template} values={parameters} onChange={setParameters} />
          <OutputPanel template={template} value={output} onChange={setOutput} />
          <div className="actions">
            {datasetId && <a className="button primary small" href={href(['datasets', datasetId], { template: template.name })}>打开这份数据集</a>}
            {props.canCreate && <a className="button quiet small" href={href(['datasets', 'new'], { template: template.name })}>新建数据集</a>}
          </div>
        </section>
      </aside>
      <div className="col-main">
        <section className="card"><PreviewCanvas preview={preview} context={{ parameters: names }} /></section>
      </div>
    </div>
  );
}
