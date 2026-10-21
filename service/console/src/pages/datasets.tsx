/**
 * 数据集：控制台的首页与中心（原型方案一，M282）。
 * - 列表：本租户的数据集；勾选同一数据定义的几份，一起出图；
 * - 编辑：左边是按编译产物生成的表单（M248），边填边经 POST /v1/dataset-checks 校验，问题显示在字段下面；
 *   右边是草稿预览与参数面板，问题位置叠加在图上；保存、修改、复制都经数据集接口（M270）。出图在侧栏里进行。
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { DatasetForm, focusField, problemsByPath } from '../components/form-fields.js';
import { defaultOutput, defaultParameters, OutputPanel, ParameterPanel, type ParameterValues } from '../components/parameters.js';
import { PreviewCanvas } from '../components/preview-canvas.js';
import { countText, ErrorBox, ProblemList } from '../components/problems.js';
import { formOf } from '../form/schema.js';
import { canonicalText, fromJson, toJsonText } from '../form/value.js';
import { go, href, problemsOf, useLivePreview, useLoad } from '../hooks.js';
import type { OutputSettings, Problem, SchemaRef, StaticSchemaSummary, TemplateInfo } from '../types.js';
import { BatchSheet, DeliverSheet, recentBatches } from './deliver.js';
import { ImportSheet } from './import.js';
import { sameSchema, schemaText } from './templates.js';

/** 跨页面的一句提示（如保存后跳到数据集页）。 */
let flash: string | undefined;

const datasetTitle = (entry: { id: string; name?: string }) => entry.name || entry.id;

export function DatasetList(props: {
  readonly deliver?: { readonly datasetIds: readonly string[]; readonly templateName?: string };
  /** 打开 Excel 导入侧栏（票据 13）。 */
  readonly importing?: { readonly templateName?: string };
}) {
  const loaded = useLoad(async () => {
    const [datasets, templates, schemas] = await Promise.all([api.datasets(), api.templates(), api.staticSchemas()]);
    return { datasets: datasets.datasets, templates: templates.templates.filter((template) => !template.problems), schemas: schemas.staticSchemas };
  }, 'datasets');
  const [template, setTemplate] = useState('');
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set(props.deliver?.datasetIds ?? []));
  const data = loaded.data;
  const templatesFor = (ref: SchemaRef | undefined) => data?.templates.filter((candidate) => sameSchema(candidate.base, ref)) ?? [];
  const selected = data?.datasets.filter((entry) => chosen.has(entry.id)) ?? [];
  const sameDefinition = selected.every((entry) => sameSchema(entry.staticSchema, selected[0]?.staticSchema));
  const toggle = (id: string, on: boolean) => setChosen((previous) => {
    const next = new Set(previous);
    if (on) next.add(id); else next.delete(id);
    return next;
  });
  const recent = recentBatches();

  return (
    <section className="page">
      <div className="title-row">
        <div>
          <h1>数据集</h1>
          <p className="lede">一份数据集是一个业务对象的数据，比如一条线路、一块胸牌。按数据定义填写，保存后可以修改、复制，随时出图。</p>
        </div>
        {data && (
          <form className="actions" onSubmit={(event) => { event.preventDefault(); if (template) go(['datasets', 'new'], { template }); }}>
            <label htmlFor="new-dataset-template" className="visually-hidden">新建数据集用的模板</label>
            <select id="new-dataset-template" value={template} onChange={(event) => setTemplate(event.target.value)}>
              <option value="">选择模板…</option>
              {data.templates.filter((entry) => data.schemas.some((schema) => sameSchema(schema, entry.base))).map((entry) => (
                <option key={entry.name} value={entry.name}>{entry.name}（{schemaText(entry.base, data.schemas)}）</option>
              ))}
            </select>
            <button type="submit" className="primary" disabled={!template}>新建数据集</button>
            <a className="button" href={href(['import'], { template: template || undefined })}>从 Excel 导入…</a>
          </form>
        )}
      </div>
      <ErrorBox problems={loaded.problems} title="读不到数据集" />
      {loaded.loading && !data && <p className="muted">正在读取…</p>}
      {data && (
        <div className="card" style={{ padding: '8px 12px' }}>
          <table className="table">
            <thead>
              <tr>
                <th className="check"><span className="visually-hidden">选择</span></th>
                <th>名称</th><th>数据定义</th><th>可用的模板</th><th><span className="visually-hidden">操作</span></th>
              </tr>
            </thead>
            <tbody>
              {data.datasets.length === 0 && <tr><td colSpan={5} className="muted">还没有数据集。选一个模板，新建第一份。</td></tr>}
              {data.datasets.map((entry) => {
                const usable = templatesFor(entry.staticSchema);
                return (
                  <tr key={entry.id}>
                    <td className="check"><input type="checkbox" aria-label={`选择 ${datasetTitle(entry)}`} checked={chosen.has(entry.id)} onChange={(event) => toggle(entry.id, event.target.checked)} /></td>
                    <td>
                      <a href={href(['datasets', entry.id])} style={{ fontWeight: 600 }}>{datasetTitle(entry)}</a>
                      {entry.name && <div className="mono muted">{entry.id}</div>}
                    </td>
                    <td>{schemaText(entry.staticSchema, data.schemas)}</td>
                    <td>{usable.length ? usable.map((candidate) => candidate.name).join('、') : <span className="muted">没有</span>}</td>
                    <td className="row-actions">
                      <a className="button small quiet" href={href(['datasets', entry.id])}>打开</a>
                      {usable.length > 0 && <a className="button small quiet" href={href(['datasets', entry.id, 'deliver'])}>出图…</a>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {selected.length > 0 && (
        <div className="bar" role="region" aria-label="已选的数据集">
          <span>已选 {selected.length} 份</span>
          {!sameDefinition && <span className="small">要一起出图的数据集须用同一个数据定义</span>}
          <span style={{ flex: 1 }} />
          <button type="button" className="small" style={{ borderColor: 'var(--bg)', color: 'var(--bg)' }} onClick={() => setChosen(new Set())}>取消选择</button>
          <a className={`button small primary${sameDefinition ? '' : ' disabled'}`} aria-disabled={!sameDefinition || undefined}
            href={sameDefinition ? href(['deliver'], { datasets: selected.map((entry) => entry.id).join(',') }) : undefined}>出图（{selected.length} 份）</a>
        </div>
      )}
      {recent.length > 0 && (
        <section className="card" style={{ marginTop: 24 }} aria-labelledby="recent-batches">
          <h2 id="recent-batches">本页提交过的出图任务</h2>
          <ul className="plain">
            {recent.map((entry) => <li key={entry.id} style={{ padding: '6px 0' }}><a href={href(['batches', entry.id])}>{entry.title} · {entry.template}</a> <span className="muted small">{new Date(entry.at).toLocaleString('zh-CN')}</span></li>)}
          </ul>
        </section>
      )}
      {data && props.deliver && (
        <DeliverSheet
          datasets={data.datasets.filter((entry) => props.deliver!.datasetIds.includes(entry.id))}
          templates={templatesFor(data.datasets.find((entry) => props.deliver!.datasetIds.includes(entry.id))?.staticSchema)}
          {...(props.deliver.templateName ? { templateName: props.deliver.templateName } : {})}
          onClose={() => go(['datasets'])}
          onSubmitted={(batch) => go(['batches', batch.id])} />
      )}
      {data && props.importing && (
        <ImportSheet templates={data.templates} schemas={data.schemas} {...(props.importing.templateName ? { templateName: props.importing.templateName } : {})}
          onClose={() => go(['datasets'])} onSubmitted={(batch) => go(['batches', batch.id])} />
      )}
    </section>
  );
}

interface EditorInput {
  readonly templates: readonly TemplateInfo[];
  readonly schemas: readonly StaticSchemaSummary[];
  readonly identity: Record<string, unknown>;
  readonly data: unknown;
  readonly compiled: Record<string, unknown>;
}

export type EditorSheet = { readonly kind: 'deliver' } | { readonly kind: 'batch'; readonly id: string };

export function DatasetEditor(props: { readonly id?: string; readonly templateName?: string; readonly sheet?: EditorSheet }) {
  const loaded = useLoad(async (): Promise<EditorInput> => {
    const [templateList, schemas] = await Promise.all([api.templates(), api.staticSchemas()]);
    const templates = templateList.templates.filter((template) => !template.problems);
    let identity: Record<string, unknown>, data: unknown = {};
    if (props.id !== undefined) {
      const document = JSON.parse(await api.datasetText(props.id)) as { dataset: Record<string, unknown>; data?: unknown };
      identity = document.dataset;
      data = fromJson(document.data ?? {});
    } else {
      const template = templates.find((candidate) => candidate.name === props.templateName);
      if (!template?.base) throw new Error('新建数据集要先选模板：数据集按模板的数据定义填写');
      identity = { staticSchema: template.base };
    }
    const ref = identity['staticSchema'] as SchemaRef;
    const detail = await api.staticSchema(ref.name, ref.version);
    return { templates, schemas: schemas.staticSchemas, identity, data, compiled: detail.compiled };
  }, `${props.id ?? '新建'}:${props.templateName ?? ''}`);

  return (
    <section className="page">
      <nav className="crumbs" aria-label="位置">
        <a href={href(['datasets'])}>数据集</a><span aria-hidden="true">/</span>
        <span>{props.id === undefined ? '新建' : props.id}</span>
      </nav>
      <ErrorBox problems={loaded.problems} title="打不开数据集" />
      {loaded.loading && !loaded.data && <p className="muted">正在读取…</p>}
      {loaded.data && <Editor key={`${props.id ?? ''}:${JSON.stringify(loaded.data.identity['staticSchema'] ?? '')}`}
        input={loaded.data} {...(props.id === undefined ? {} : { id: props.id })} {...(props.templateName ? { templateName: props.templateName } : {})}
        {...(props.sheet ? { sheet: props.sheet } : {})} />}
    </section>
  );
}

const documentText = (identity: Record<string, unknown>, data: unknown) => `${toJsonText({ dataset: identity, data })}\n`;

/** 身份部分：ID、名称、所选的静态数据定义在前，其余键（如 origin）原样保留。 */
function identityOf(loaded: Record<string, unknown>, id: string, name: string): Record<string, unknown> {
  const { id: _id, name: _name, staticSchema, ...rest } = loaded;
  return { ...(id ? { id } : {}), ...(name ? { name } : {}), staticSchema, ...rest };
}

function Editor(props: { readonly input: EditorInput; readonly id?: string; readonly templateName?: string; readonly sheet?: EditorSheet }) {
  const { input } = props;
  const form = useMemo(() => formOf(input.compiled), [input.compiled]);
  const staticSchema = input.identity['staticSchema'] as SchemaRef;
  const [newId, setNewId] = useState('');
  const [name, setName] = useState(typeof input.identity['name'] === 'string' ? input.identity['name'] : '');
  const [data, setData] = useState<unknown>(input.data);
  const identity = useMemo(() => identityOf(input.identity, props.id ?? newId.trim(), name.trim()), [input.identity, props.id, newId, name]);
  const text = useMemo(() => documentText(identity, data), [identity, data]);
  const [baseline, setBaseline] = useState(() => canonicalText({ dataset: identity, data: input.data }));
  const isNew = props.id === undefined;
  const dirty = isNew || canonicalText({ dataset: identity, data }) !== baseline;

  // 边填边校验：只校验不保存，问题以服务端为准。
  const [check, setCheck] = useState<readonly Problem[]>();
  const [checkFailed, setCheckFailed] = useState<readonly Problem[]>();
  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(() => {
      api.checkDataset(text).then((reply) => { if (live) { setCheck(reply.problems); setCheckFailed(undefined); } },
        (error: unknown) => { if (live) setCheckFailed(problemsOf(error)); });
    }, 350);
    return () => { live = false; window.clearTimeout(timer); };
  }, [text]);

  const templates = input.templates.filter((template) => sameSchema(template.base, staticSchema));
  const [templateName, setTemplateName] = useState(props.templateName && templates.some((template) => template.name === props.templateName) ? props.templateName : templates[0]?.name ?? '');
  const template = templates.find((candidate) => candidate.name === templateName);
  const [parameters, setParameters] = useState<ParameterValues>(() => (template ? defaultParameters(template) : {}));
  const [output, setOutput] = useState<OutputSettings | undefined>(() => (template ? defaultOutput(template) : undefined));
  const chooseTemplate = (nameOfTemplate: string) => {
    setTemplateName(nameOfTemplate);
    const next = templates.find((candidate) => candidate.name === nameOfTemplate);
    setParameters(next ? defaultParameters(next) : {});
    setOutput(next ? defaultOutput(next) : undefined);
  };
  const request = useMemo(() => (template && output ? { template: template.name, dataset: { inline: JSON.parse(text) as unknown }, parameters, output } : undefined),
    [template, output, parameters, text]);
  const preview = useLivePreview(request, 700);

  const [saving, setSaving] = useState(false);
  const [saveProblems, setSaveProblems] = useState<readonly Problem[]>();
  const [status, setStatus] = useState<string | undefined>(() => { const value = flash; flash = undefined; return value; });
  const save = async () => {
    setSaveProblems(undefined);
    setStatus(undefined);
    if (isNew && !newId.trim()) {
      setSaveProblems([{ code: 'console.idMissing', level: 'severe', location: { kind: 'input', source: 'dataset' }, message: '保存前先填数据集 ID' }]);
      return;
    }
    setSaving(true);
    try {
      const reply = isNew ? await api.createDataset(text) : await api.updateDataset(props.id!, text);
      const hints = reply.problems.length ? `；${countText(reply.problems)}` : '';
      if (isNew) {
        flash = `已保存数据集 ${reply.dataset.id}${hints}`;
        go(['datasets', reply.dataset.id], { template: templateName || undefined });
      } else {
        setBaseline(canonicalText({ dataset: identity, data }));
        setStatus(`已保存${hints}`);
      }
    } catch (error) { setSaveProblems(problemsOf(error)); }
    finally { setSaving(false); }
  };

  const [copying, setCopying] = useState(false);
  const [copyId, setCopyId] = useState('');
  const [copyName, setCopyName] = useState('');
  const [copyProblems, setCopyProblems] = useState<readonly Problem[]>();
  const copy = async () => {
    if (isNew) return;
    setCopyProblems(undefined);
    try {
      const reply = await api.copyDataset(props.id!, { id: copyId.trim(), ...(copyName.trim() ? { name: copyName.trim() } : {}) });
      flash = `已复制为 ${reply.dataset.id}`;
      go(['datasets', reply.dataset.id], { template: templateName || undefined });
    } catch (error) { setCopyProblems(problemsOf(error)); }
  };

  const fieldProblems = useMemo(() => problemsByPath(check ?? []), [check]);
  const names = useMemo(() => new Map((template?.parameters ?? []).map((parameter) => [parameter.name, parameter.displayName])), [template]);
  const severe = check?.filter((problem) => problem.level === 'severe').length ?? 0;
  const entry = { id: props.id ?? newId.trim(), ...(name.trim() ? { name: name.trim() } : {}) };
  const close = () => go(['datasets', props.id!], { template: templateName || undefined });

  return (
    <>
      <div className="title-row">
        <div>
          <h1>{isNew ? '新建数据集' : name.trim() || props.id}</h1>
          <div className="meta" aria-live="polite" data-testid="check-summary">
            <span>数据定义 {schemaText(staticSchema, input.schemas)}</span>
            {!isNew && (dirty ? <span className="warn">有未保存的修改</span> : <span>已保存</span>)}
            <span className={severe ? 'bad' : undefined}>{check === undefined ? '正在校验…' : `校验：${countText(check)}`}</span>
            {status && <span className="status" role="status">{status}</span>}
          </div>
        </div>
        <div className="actions">
          {!isNew && <button type="button" disabled={dirty} title={dirty ? '先保存修改再复制' : undefined} onClick={() => setCopying(!copying)}>复制为新数据集</button>}
          <button type="button" disabled={saving || !dirty} onClick={() => void save()}>{saving ? '正在保存…' : '保存'}</button>
          {!isNew && (
            dirty || !templateName
              ? <button type="button" className="primary" disabled title={dirty ? '保存后才能出图' : '没有用这个数据定义的模板'}>出图…</button>
              : <a className="button primary" href={href(['datasets', props.id!, 'deliver'], { template: templateName })}>出图…</a>
          )}
        </div>
      </div>
      <ErrorBox problems={saveProblems} title="没有保存" />
      {copying && !isNew && (
        <form className="card" aria-label="复制数据集" onSubmit={(event) => { event.preventDefault(); void copy(); }} style={{ marginBottom: 20 }}>
          <h2>复制为新数据集</h2>
          <div className="fields">
            <div className="field">
              <label htmlFor="copy-id" className="required">新数据集 ID</label>
              <input id="copy-id" type="text" value={copyId} onChange={(event) => setCopyId(event.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="copy-name">新名称</label>
              <input id="copy-name" type="text" value={copyName} onChange={(event) => setCopyName(event.target.value)} />
            </div>
          </div>
          <div className="actions" style={{ marginTop: 16 }}>
            <button type="submit" className="primary">复制</button>
            <button type="button" onClick={() => setCopying(false)}>取消</button>
          </div>
          <ErrorBox problems={copyProblems} title="没有复制" />
        </form>
      )}

      <div className="columns">
        <div className="col-main">
          <section className="card" aria-label="数据集信息">
            <div className="fields">
              <div className="field">
                <label htmlFor="dataset-id" className={isNew ? 'required' : undefined}>数据集 ID</label>
                {isNew
                  ? <input id="dataset-id" type="text" value={newId} onChange={(event) => setNewId(event.target.value)} placeholder="如 m402-wanguocheng" />
                  : <output id="dataset-id" className="mono" style={{ paddingTop: 10 }}>{props.id}</output>}
              </div>
              <div className="field">
                <label htmlFor="dataset-name">名称</label>
                <input id="dataset-name" type="text" value={name} onChange={(event) => setName(event.target.value)} placeholder="给人看的名字，可不填" />
              </div>
            </div>
          </section>
          <ErrorBox problems={checkFailed} title="校验失败" />
          <DatasetForm spec={form} title={input.schemas.find((schema) => sameSchema(schema, staticSchema))?.displayName ?? form.title} value={data} path="" onChange={setData} problems={fieldProblems} />
          {check && check.length > 0 && (
            <details className="card">
              <summary>全部校验问题（{check.length}）</summary>
              <div style={{ marginTop: 12 }}>
                <ProblemList problems={check} context={{ form }} onSelect={(problem) => { if (problem.location.kind === 'field') focusField(problem.location.path); }} />
              </div>
            </details>
          )}
        </div>

        <aside className="col-side sticky" aria-label="草稿预览">
          <section className="card">
            <div className="card-head">
              <h2>草稿预览</h2>
              <label className="actions small muted" htmlFor="editor-template">模板
                <select id="editor-template" value={templateName} onChange={(event) => chooseTemplate(event.target.value)}>
                  {templates.length === 0 && <option value="">没有用这个数据定义的模板</option>}
                  {templates.map((candidate) => <option key={candidate.name} value={candidate.name}>{candidate.name}</option>)}
                </select>
              </label>
            </div>
            {template && output && (
              <div className="soft" style={{ marginBottom: 16 }}>
                <ParameterPanel template={template} values={parameters} onChange={setParameters} />
                <details style={{ marginTop: 12 }}>
                  <summary className="small">尺寸与分辨率：{output.width} × {output.height} mm · {output.dpi} DPI · {output.format.toUpperCase()}</summary>
                  <div style={{ marginTop: 12 }}><OutputPanel template={template} value={output} onChange={setOutput} /></div>
                </details>
              </div>
            )}
            <PreviewCanvas preview={preview} context={{ form, parameters: names }} onFieldProblem={focusField} empty={template ? '还没有预览' : '没有可用的模板'} />
          </section>
        </aside>
      </div>

      {props.sheet?.kind === 'deliver' && !isNew && (
        <DeliverSheet datasets={[entry]} templates={templates} templateName={templateName} parameters={parameters} {...(output ? { output } : {})}
          onClose={close} onSubmitted={(batch) => go(['datasets', props.id!, 'batches', batch.id])} />
      )}
      {props.sheet?.kind === 'batch' && <BatchSheet id={props.sheet.id} onClose={close} />}
    </>
  );
}

