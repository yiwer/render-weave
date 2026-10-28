/**
 * 出图记录（票据 14，M301）：本租户正式交付成功的每一张图都有一条记录（票据 08）。
 * - 查询：按登记日期、模板与批次筛选（GET /v1/records），按登记时间倒序，一页 50 条，"加载更多"接着翻；
 *   筛选写在 # 路由的查询串里（#/records?template=…&batch=…&from=…&to=…），可以收藏、转发。日期按浏览器的本地时间，起止都含当日；
 * - 下载图片，按项或按批次导出：导出包与本地 deliver 的成果相同，能用 renderweave record-read 与 replay 离线核对。
 */
import { useState } from 'react';
import { api, saveBlob } from '../api.js';
import { PagedFooter } from '../components/paged.js';
import { ErrorBox } from '../components/problems.js';
import { go, href, problemsOf, useLoad, usePaged } from '../hooks.js';
import type { Problem, RecordEntry } from '../types.js';
import { fileSafe, imageFileName } from './deliver.js';

interface Filters { readonly template: string; readonly batch: string; readonly from: string; readonly to: string }
const NAMES = ['template', 'batch', 'from', 'to'] as const;
export const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 本地日期（YYYY-MM-DD）的零点，往后推 days 天，写成 ISO 时刻；按日历推，夏令时切换的那天也对。 */
export function dayStart(date: string, days = 0): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(year, month - 1, day + days).toISOString();
}

const short = (batchId: string) => batchId.slice(0, 8);

export function RecordsPage(props: { readonly query: URLSearchParams }) {
  const filters = Object.fromEntries(NAMES.map((name) => [name, props.query.get(name) ?? ''])) as unknown as Filters;
  const [draft, setDraft] = useState<Filters>(filters);
  const [downloadProblems, setDownloadProblems] = useState<readonly Problem[]>();
  const templates = useLoad(() => api.templates(), 'templates');
  const reversed = DATE.test(filters.from) && DATE.test(filters.to) && filters.to < filters.from;
  const records = usePaged((before) => (reversed ? Promise.resolve({ items: [] }) : api.records({
    ...(filters.batch ? { batchId: filters.batch } : {}), ...(filters.template ? { template: filters.template } : {}),
    ...(DATE.test(filters.from) ? { from: dayStart(filters.from) } : {}), ...(DATE.test(filters.to) ? { to: dayStart(filters.to, 1) } : {}),
    ...(before ? { before } : {}),
  })), JSON.stringify(filters));
  const filtered = NAMES.some((name) => filters[name]);
  // 批次 ID 来自输入框或地址栏，拼进路径前要编码。
  const batchPath = `/v1/batches/${encodeURIComponent(filters.batch)}`;

  const download = async (path: string, filename: string) => {
    setDownloadProblems(undefined);
    try { saveBlob(await api.download(path), filename); } catch (error) { setDownloadProblems(problemsOf(error)); }
  };
  const set = (name: keyof Filters, value: string) => setDraft((previous) => ({ ...previous, [name]: value }));

  return (
    <section className="page">
      <div className="title-row">
        <div>
          <h1>出图记录</h1>
          <p className="lede">正式交付成功的每一张图都有一条记录，带着当时的数据、模板与资源。导出包能用 <code>renderweave record-read</code> 与 <code>replay</code> 离线核对与重放。</p>
        </div>
      </div>
      <form className="card filters" role="search" aria-label="筛选出图记录"
        onSubmit={(event) => { event.preventDefault(); go(['records'], Object.fromEntries(NAMES.map((name) => [name, draft[name].trim() || undefined]))); }}>
        <div className="field">
          <label htmlFor="records-from">起始日期</label>
          <input id="records-from" type="date" value={draft.from} onChange={(event) => set('from', event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="records-to">截止日期</label>
          <input id="records-to" type="date" value={draft.to} onChange={(event) => set('to', event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="records-template">模板</label>
          <select id="records-template" value={draft.template} onChange={(event) => set('template', event.target.value)}>
            <option value="">全部模板</option>
            {/* 筛选里的模板已不在列表里时也留着它，免得选择框悄悄变成"全部"。 */}
            {[...new Set([...(templates.data?.templates.map((template) => template.name) ?? []), ...(filters.template ? [filters.template] : [])])].map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        </div>
        <div className="field wide-field">
          <label htmlFor="records-batch">批次 ID</label>
          <input id="records-batch" type="text" className="mono" value={draft.batch} placeholder="全部批次" onChange={(event) => set('batch', event.target.value)} />
        </div>
        <div className="actions">
          <button type="submit" className="primary">查询</button>
          {filtered && <a className="button quiet" href={href(['records'])}>清除筛选</a>}
        </div>
      </form>
      {reversed && <p className="field-problems" role="alert"><span style={{ color: 'var(--bad)' }}>截止日期不能早于起始日期</span></p>}

      {filters.batch && (
        <section className="card batch-bar" aria-label={`批次 ${short(filters.batch)}`}>
          <div style={{ flex: '1 1 260px' }}>
            <div className="eyebrow">只看这一批</div>
            <code>{filters.batch}</code>
          </div>
          <a className="button small quiet" href={href(['batches', filters.batch])}>打开出图任务</a>
          <button type="button" className="small quiet" onClick={() => void download(`${batchPath}/images.zip`, `batch-${fileSafe(filters.batch)}-images.zip`)}>下载整批图片（zip）</button>
          <button type="button" className="small primary" onClick={() => void download(`${batchPath}/export.zip`, `batch-${fileSafe(filters.batch)}.zip`)}>导出整批记录（zip）</button>
        </section>
      )}
      <ErrorBox problems={records.problems} title="查不到出图记录" />
      <ErrorBox problems={downloadProblems} title="下载失败" />

      <div className="card" style={{ padding: '8px 12px', marginTop: 16 }}>
        <table className="table">
          <thead>
            <tr><th>登记时间</th><th>模板</th><th>渲染项</th><th>批次</th><th><span className="visually-hidden">操作</span></th></tr>
          </thead>
          <tbody>
            {records.items.map((record) => <RecordRow key={`${record.batchId}#${record.index}`} record={record} onDownload={(path, filename) => void download(path, filename)} />)}
            {!records.loading && !records.problems && records.items.length === 0 && (
              <tr><td colSpan={5} className="muted">{filtered ? '没有符合条件的出图记录。' : '还没有出图记录。正式交付成功之后，每一张图都会在这里。'}</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <PagedFooter paged={records} />
    </section>
  );
}

function RecordRow(props: { readonly record: RecordEntry; readonly onDownload: (path: string, filename: string) => void }) {
  const { record } = props, item = `/v1/batches/${record.batchId}/items/${record.index}`;
  return (
    <tr data-testid="record-row" data-batch={record.batchId} data-index={record.index} data-id={record.id}>
      <td>{new Date(record.deliveredAt).toLocaleString('zh-CN')}</td>
      <td>{record.template}</td>
      <td><span className="mono">{record.id}</span><div className="muted small">第 {record.index} 项</div></td>
      <td><a className="mono" href={href(['records'], { batch: record.batchId })} aria-label={`只看批次 ${short(record.batchId)}`} title="只看这一批">{short(record.batchId)}</a></td>
      <td className="row-actions">
        <button type="button" className="small quiet" onClick={() => props.onDownload(`${item}/files/${record.image}`, imageFileName(record.index, record.id, record.image))}>下载图片</button>
        <button type="button" className="small quiet" onClick={() => props.onDownload(`${item}/export.zip`, `batch-${record.batchId}-${String(record.index).padStart(4, '0')}.zip`)}>导出记录</button>
      </td>
    </tr>
  );
}
