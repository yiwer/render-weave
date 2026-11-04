/** 工作簿智能导入：任务列表、上传和来源审核。正式数据只在整组确认后产生。 */
import { useEffect, useMemo, useState } from 'react';
import { api, saveBlob } from '../api.js';
import { DatasetForm, problemsByPath } from '../components/form-fields.js';
import { ErrorBox, ProblemList } from '../components/problems.js';
import { Loading } from '../components/motifs.js';
import { formOf } from '../form/schema.js';
import { canonicalText, fromJson, toJsonText } from '../form/value.js';
import { go, guardNavigation, href, problemsOf, useLoad } from '../hooks.js';
import type { ImportDetail, ImportJob, ImportReview } from '../import-types.js';
import type { Problem } from '../types.js';
import { schemaText } from './templates.js';

const STATUS: Record<ImportJob['status'], string> = { queued: '等待处理', running: '正在提取', needsReview: '待核对', applied: '已保存', failed: '提取失败', cancelled: '已取消' };
const active = (job: ImportJob) => job.status === 'queued' || job.status === 'running';
const selectValue = (schema: { name: string; version: number }) => JSON.stringify([schema.name, schema.version]);
async function base64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer()); let value = '';
  for (let i = 0; i < bytes.length; i += 32768) value += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(value);
}
export function DatasetImports(props: { schemaName?: string; schemaVersion?: string }) {
  const loaded = useLoad(async () => ({ ...await api.agentJobs(), schemas: (await api.staticSchemas()).staticSchemas }), 'dataset-imports');
  const [selected, setSelected] = useState(props.schemaName && props.schemaVersion ? selectValue({ name: props.schemaName, version: Number(props.schemaVersion) }) : '');
  const [file, setFile] = useState<File>(); const [brief, setBrief] = useState('');
  const [busy, setBusy] = useState(false), [problems, setProblems] = useState<readonly Problem[]>();
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const data = loaded.data, chosen = data?.schemas.find(s => selectValue(s) === selected);
  const maxWorkbookBytes = data?.maxWorkbookBytes ?? 0;
  const sizeLimit = maxWorkbookBytes >= 1024 * 1024 ? `${maxWorkbookBytes / (1024 * 1024)} MiB` : `${maxWorkbookBytes / 1024} KiB`;
  const reset = () => { setRequestId(crypto.randomUUID()); setProblems(undefined); };
  useEffect(() => {
    if (!data?.jobs.some(active)) return;
    const timer = window.setTimeout(loaded.reload, 2500); return () => clearTimeout(timer);
  }, [data]);
  const submit = async () => {
    if (!file || !chosen || !brief.trim()) return;
    setBusy(true); setProblems(undefined);
    try {
      if (file.size > maxWorkbookBytes) throw new Error(`工作簿不能超过 ${sizeLimit}`);
      const reply = await api.createAgentJob({ requestId, staticSchema: { name: chosen.name, version: chosen.version }, filename: file.name, workbook: await base64(file), brief: brief.trim() });
      go(['dataset-imports', reply.job.id]);
    } catch (e) { setProblems(problemsOf(e)); } finally { setBusy(false); }
  };
  return <section className="page">
    <nav className="crumbs" aria-label="位置"><a href={href(['datasets'])}>数据集</a><span>/</span><span>智能导入</span></nav>
    <div className="title-row"><div><h1>智能导入数据集</h1><p className="lede">上传现有工作簿，按选定的定义整理数据。核对原文和批注后，再保存到数据集。</p></div><a className="button quiet" href={href(['import'])}>标准表格批量出图…</a></div>
    <ErrorBox problems={loaded.problems} title="读不到导入任务" />
    {loaded.loading && !data && <Loading />}
    {data && <div className="columns import-start">
      <form className="card col-main" onSubmit={event => { event.preventDefault(); void submit(); }} aria-label="智能导入资料">
        <h2>开始一次导入</h2>
        {!data.enabled && <p className="soft">智能导入的处理服务尚未启用。已有任务仍可查看，数据集可以手动创建。</p>}
        {!data.schemas.length && <p className="soft">还没有静态数据定义，请先由管理员发布定义。</p>}
        <div className="field"><label htmlFor="import-definition">静态数据定义与版本</label>
          <select id="import-definition" required disabled={busy} value={selected} onChange={e => { reset(); setSelected(e.target.value); }}>
            <option value="">请选择…</option>{data.schemas.map(s => <option key={selectValue(s)} value={selectValue(s)}>{schemaText(s, data.schemas)}</option>)}
          </select>
        </div>
        <div className="field"><label htmlFor="smart-workbook">Excel 工作簿</label><input id="smart-workbook" type="file" accept=".xlsx" required disabled={busy} onChange={e => { reset(); setFile(e.target.files?.[0]); }} /><p className="help">.xlsx，最大 {sizeLimit}。保留工作表、合并关系与传统批注。</p></div>
        <div className="field"><label htmlFor="import-brief">需要提取什么</label><textarea id="import-brief" required maxLength={12000} rows={5} value={brief} disabled={busy} onChange={e => { reset(); setBrief(e.target.value); }} placeholder="例如：每个门店生成一份数据集，保留全部商品及顺序；备注和批注也需要核对。" /></div>
        <ErrorBox problems={problems} title="没有开始导入" />
        <div className="actions"><button className="primary" type="submit" disabled={busy || !data.enabled || !chosen || !file || !brief.trim()}>{busy ? '正在上传…' : '开始提取'}</button><a href={href(['datasets', 'new'])}>手动创建数据集</a></div>
        <p className="small muted">提取时不会写入正式数据。页面关闭后任务继续，可以从右侧重新打开。</p>
      </form>
      <aside className="col-side"><section className="card"><h2>导入记录 <span className="muted">{data.jobs.length}</span></h2>
        {!data.jobs.length ? <p className="muted">还没有导入记录。第一次提取从左侧开始。</p> : <ul className="import-jobs">{data.jobs.map(job => <li key={job.id}><a href={href(['dataset-imports', job.id])}><strong>{job.filename}</strong><span className={`chip ${job.status === 'applied' ? 'ok' : ''}`}>{STATUS[job.status]}</span><span className="small muted">{schemaText(job.staticSchema, data.schemas)} · {new Date(job.createdAt).toLocaleString('zh-CN')}</span></a></li>)}</ul>}
      </section></aside>
    </div>}
  </section>;
}

export function DatasetImportDetail(props: { id: string }) {
  const loaded = useLoad(() => api.agentJob(props.id), props.id);
  const [override, setOverride] = useState<ImportDetail>();
  const detail = override ?? loaded.data;
  const [dirty, setDirty] = useState(false);
  const refresh = () => { if (dirty && !window.confirm('修改还没有保存，确定刷新？')) return; setOverride(undefined); loaded.reload(); };
  useEffect(() => {
    if (!detail || !active(detail.job)) return;
    const timer = setTimeout(refresh, 2000); return () => clearTimeout(timer);
  }, [detail]);
  const [problems, setProblems] = useState<readonly Problem[]>();
  const [busy, setBusy] = useState(false);
  const cancel = async () => { setBusy(true); try { setOverride(await api.cancelAgentJob(props.id)); } catch (e) { setProblems(problemsOf(e)); } finally { setBusy(false); } };
  const download = async () => { try { saveBlob(await api.agentSource(props.id), detail!.job.filename); } catch (e) { setProblems(problemsOf(e)); } };
  return <section className="page">
    <nav className="crumbs" aria-label="位置"><a href={href(['datasets'])}>数据集</a><span>/</span><a href={href(['dataset-imports'])}>智能导入</a><span>/</span><span>任务详情</span></nav>
    <ErrorBox problems={loaded.problems} title="打不开任务" />
    {!detail && loaded.loading && <Loading />}
    {detail && <>
      <div className="title-row"><div><h1>{detail.job.filename}</h1><div className="meta"><span className="chip">{STATUS[detail.job.status]}</span><span>{detail.job.staticSchema.name} v{detail.job.staticSchema.version}</span></div></div><div className="actions"><button type="button" onClick={() => void download()}>下载原件</button>{active(detail.job) && <button type="button" disabled={busy} onClick={() => void cancel()}>取消提取</button>}<button type="button" onClick={refresh}>刷新</button></div></div>
      <ErrorBox problems={problems} title="操作没有完成" />
      <details className="card import-progress" open={active(detail.job)}><summary>{active(detail.job) ? '处理进度' : '查看处理记录'} · {detail.job.events.at(-1)?.message}</summary><ol role="log" aria-label="处理进度">{detail.job.events.map(e => <li key={e.sequence}><time>{new Date(e.at).toLocaleTimeString('zh-CN')}</time><span>{e.message}</span></li>)}</ol><p className="small">提取要求：{detail.job.brief}</p><p className="small muted">人工业务审核工时与实际扣费未知。</p></details>
      {active(detail.job) && <div className="card import-wait"><Loading /><h2>正在整理这份工作簿</h2><p>完成后会显示候选数据、原表来源及批注。可以离开页面，稍后回来核对。</p></div>}
      {detail.job.status === 'failed' || detail.job.status === 'cancelled' ? <div className="card"><h2>{STATUS[detail.job.status]}</h2><p>{detail.job.message ?? '本次任务没有保存任何数据集。'}</p><a className="button primary" href={href(['dataset-imports'], { schema: detail.job.staticSchema.name, version: String(detail.job.staticSchema.version) })}>重新导入</a></div> : null}
      {detail.job.status === 'applied' && <section className="card import-complete"><h2>已保存 {detail.job.datasetIds?.length ?? 0} 份数据集</h2><p>现在可以打开数据集继续编辑，或选择兼容模板出图。</p><div className="actions">{detail.job.datasetIds?.map(id => <a key={id} className="button" href={href(['datasets', id])}>{id}</a>)}</div></section>}
      {detail.review && <ImportReviewPanel key={`${props.id}:${detail.job.revision}`} detail={detail} review={detail.review} onChanged={setOverride} onDirty={setDirty} />}
    </>}
  </section>;
}

function ImportReviewPanel({ detail, review, onChanged, onDirty }: { detail: ImportDetail; review: ImportReview; onChanged: (detail: ImportDetail) => void; onDirty: (dirty: boolean) => void }) {
  const loaded = useLoad(() => api.staticSchema(detail.job.staticSchema.name, detail.job.staticSchema.version), selectValue(detail.job.staticSchema));
  const [index, setIndex] = useState(0), [reason, setReason] = useState(''), [confirmed, setConfirmed] = useState(false);
  const candidate = review.candidates[index], document = candidate?.document;
  const [value, setValue] = useState(() => fromJson(document?.data ?? {}));
  const dirty = !!document && canonicalText(value) !== canonicalText(fromJson(document.data));
  useEffect(() => { onDirty(dirty); return () => onDirty(false); }, [dirty, onDirty]);
  const [busy, setBusy] = useState(false), [problems, setProblems] = useState<readonly Problem[]>();
  const [source, setSource] = useState<{ sheet?: string; cell?: string; offset: number }>({ offset: 0 });
  const cells = useLoad(() => api.agentCells(detail.job.id, source), JSON.stringify(source));
  const readonly = detail.job.status !== 'needsReview';
  const form = useMemo(() => loaded.data ? formOf(loaded.data.compiled) : undefined, [loaded.data]);
  useEffect(() => {
    if (!dirty) return;
    const release = guardNavigation(() => window.confirm('修改还没有保存，确定离开？'));
    const unload = (e: BeforeUnloadEvent) => e.preventDefault(); window.addEventListener('beforeunload', unload);
    return () => { release(); window.removeEventListener('beforeunload', unload); };
  }, [dirty]);
  const choose = (next: number) => {
    if (dirty && !window.confirm('修改还没有保存，确定切换数据集？')) return;
    setIndex(next); setValue(fromJson(review.candidates[next]?.document?.data ?? {})); setReason(''); setProblems(undefined); setConfirmed(false);
  };
  const save = async () => {
    const pending = review.pending.find(p => p.file === candidate?.path);
    if (!document || !pending || !reason.trim()) return;
    setBusy(true); setProblems(undefined);
    try { onChanged(await api.reviewAgentJob(detail.job.id, { revision: detail.job.revision, item: pending.item, document: { ...document, data: JSON.parse(toJsonText(value)) }, reason: reason.trim() })); }
    catch (e) { setProblems(problemsOf(e)); } finally { setBusy(false); }
  };
  const apply = async () => {
    setBusy(true); setProblems(undefined);
    try { onChanged(await api.applyAgentJob(detail.job.id, detail.job.revision)); } catch (e) { setProblems(problemsOf(e)); } finally { setBusy(false); }
  };
  const sheetName = (id: string) => review.excel?.sheets.find(s => s.id === id)?.name ?? id;
  const sources = review.excel?.sources.filter(s => s.datasetId === candidate?.name) ?? [];
  return <>
    <ErrorBox problems={problems} title="修改或保存没有完成" />
    <div className="import-review-grid">
      <aside className="card import-source"><div className="card-head"><h2>原表与来源</h2><span className="small muted">只读</span></div>
        <label className="field">工作表<select aria-label="工作表" value={source.sheet ?? cells.data?.sheet ?? ''} onChange={e => setSource({ sheet: e.target.value, offset: 0 })}>{review.excel?.sheets.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        {source.cell && <p className="small">定位到 {source.cell} <button type="button" className="quiet small" onClick={() => setSource({ sheet: source.sheet, offset: 0 })}>查看整表</button></p>}
        <ErrorBox problems={cells.problems} title="读不到原表" />
        <div className="table-box"><table className="table"><thead><tr><th>单元格</th><th>原文 / 显示值</th></tr></thead><tbody>{cells.data?.cells.map(c => <tr key={c.address}><td className="mono">{c.address}</td><td className="import-cell-text">{c.display ?? String(c.value ?? '')}{c.formula && <div className="small muted">公式：{c.formula}</div>}</td></tr>)}</tbody></table></div>
        {cells.data && <div className="actions small"><span>共 {cells.data.total} 个单元格</span><button type="button" disabled={!source.offset} onClick={() => setSource({ ...source, offset: Math.max(0, source.offset - 100) })}>上一页</button><button type="button" disabled={source.offset + 100 >= cells.data.total} onClick={() => setSource({ ...source, offset: source.offset + 100 })}>下一页</button></div>}
        <details className="import-evidence" open><summary>批注（{review.excel?.comments?.length ?? 0}）</summary>{review.excel?.comments?.map((c, i) => <article className="soft" key={i}><strong>{sheetName(c.sheet)} · {c.cell}</strong><p className="import-cell-text">{c.text}</p><p className="small muted">作者：{c.author || '未署名'}</p>{c.vml ? <details className="small"><summary>批注显示位置</summary>VML 零基行 {c.vml.row}、列 {c.vml.column}；锚点 {c.vml.anchor.join(', ')}；{c.vml.visible ? '可见' : '隐藏'}</details> : <p className="small muted">原件没有 VML 显示框信息，批注原文已保留。</p>}</article>)}</details>
        <details className="import-evidence"><summary>字段来源（{sources.length}）</summary><ul>{sources.map((s, i) => <li key={i}><span className="mono">{s.path}</span> · {sheetName(s.sheet)} {s.cells.map(cell => <button type="button" key={cell} className="quiet small" onClick={() => setSource({ sheet: s.sheet, cell, offset: 0 })}>{cell}</button>)}<div className="small muted">{s.rule}</div>{s.mapping && <div className="small import-cell-text">显示映射：按 {s.mapping.separators.join(' / ')} 拆分；{Object.entries(s.mapping.values).map(([key, value]) => `${key} → ${JSON.stringify(value)}`).join('；')}</div>}</li>)}</ul></details>
        <details className="import-evidence"><summary>排除范围与批注处理说明</summary><ul>{review.excel?.context.map((c, i) => <li key={i}>{sheetName(c.sheet)} {c.range}：{c.reason}</li>)}{review.excel?.commentContext?.map((c, i) => <li key={`c-${i}`}>{sheetName(c.sheet)} {c.cell} 批注：{c.reason}</li>)}</ul></details>
      </aside>
      <div className="import-candidates"><section className="card"><h2>候选数据集 <span className="muted">{review.candidates.length} 份</span></h2><label className="field">正在核对<select aria-label="正在核对" value={index} onChange={e => choose(Number(e.target.value))} disabled={busy}>{review.candidates.map((c, i) => <option key={c.path} value={i}>{c.name ?? `数据集 ${i + 1}`}{c.edited ? ' · 已人工修改' : ''}</option>)}</select></label>
        <p className="small muted">{review.notes}</p>{review.pending.filter(p => p.file === candidate?.path).map(p => <p key={p.item} className="soft import-cell-text">{p.note}{p.decision?.note && <><br />修改原因：{p.decision.note}</>}</p>)}
        <ErrorBox problems={loaded.problems} title="读不到数据定义" />
        {form && <fieldset disabled={readonly || busy} className="import-form"><DatasetForm spec={form} value={value} title={loaded.data?.displayName ?? '数据'} path="" onChange={v => { setValue(v); setConfirmed(false); }} problems={problemsByPath(candidate?.problems ?? [])} /></fieldset>}
        {candidate?.problems.length ? <ProblemList problems={candidate.problems} /> : null}
        {!readonly && <><div className="field"><label htmlFor="import-change-reason">修改原因</label><textarea id="import-change-reason" rows={2} maxLength={2000} value={reason} onChange={e => setReason(e.target.value)} placeholder="人工改值时必填，说明原表含义或修正依据。" /></div><button type="button" disabled={busy || !dirty || !reason.trim()} onClick={() => void save()}>保存修改</button></>}
      </section></div>
    </div>
    {!readonly && <section className="card import-confirm"><div><h2>确认保存整组数据</h2><p>将创建 {review.candidates.length} 份数据集。重复 ID 或严重问题会阻止整组保存。</p><label className="actions"><input type="checkbox" checked={confirmed} disabled={dirty || busy} onChange={e => setConfirmed(e.target.checked)} />我已核对全部候选、字段来源、批注及排除范围</label>{dirty && <p className="warn small">请先保存当前修改。</p>}</div><button type="button" className="primary" disabled={!confirmed || dirty || busy} onClick={() => void apply()}>{busy ? '正在保存…' : `确认保存 ${review.candidates.length} 份数据集`}</button></section>}
  </>;
}
