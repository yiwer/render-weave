/**
 * 出图：正式交付在侧栏里进行（原型方案一，M282）。
 * - 出图侧栏：选模板、对外参数与尺寸；可以按一个整数对外参数的范围出多张（如本站序号 1–35，每站一张），也可以几份数据集一起出；
 *   提交带幂等键：同一次提交重试拿回同一批次，不重复交付也不重复计费（票据 07）；
 * - 进度：逐项格子显示状态，点一项看图、下载或看问题说明；进行中能取消；结束后下载整批压缩包（票据 07、08）。
 */
import { useEffect, useMemo, useState } from 'react';
import { api, saveBlob } from '../api.js';
import { defaultOutput, defaultParameters, OutputPanel, ParameterPanel, type ParameterValues } from '../components/parameters.js';
import { ErrorBox, locationText } from '../components/problems.js';
import { href, problemsOf } from '../hooks.js';
import type { BatchItem, BatchView, ItemStatus, OutputSettings, Problem, TemplateInfo, Usage } from '../types.js';

const RECENT_KEY = 'renderweave.console.batches';
/** 一批最多 1,000 项（DSL 1.0 的批次请求）。 */
export const MAX_ITEMS = 1000;

/** 幂等键：crypto.randomUUID 只在 https 与本机地址可用，内网的 http 地址上也要能交付，所以用 getRandomValues。 */
export function idempotencyKey(): string {
  return `console-${Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

interface Recent { readonly id: string; readonly title: string; readonly template: string; readonly at: string }

/** 本标签页提交过的批次，方便回到进度。 */
export function recentBatches(): Recent[] {
  try { return JSON.parse(sessionStorage.getItem(RECENT_KEY) ?? '[]') as Recent[]; } catch { return []; }
}
export function remember(batch: BatchView, title: string): void {
  try {
    const next = [{ id: batch.id, title, template: batch.template, at: batch.createdAt }, ...recentBatches().filter((entry) => entry.id !== batch.id)].slice(0, 20);
    sessionStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch { /* 存不了就不记 */ }
}

interface Sweep { readonly name: string; readonly from: string; readonly to: string }

/** 范围里的整数；不合规或超过一批的上限时返回问题说明。 */
function sweepValues(sweep: Sweep): number[] | string {
  const from = Number(sweep.from), to = Number(sweep.to);
  if (!Number.isInteger(from) || !Number.isInteger(to)) return '起止要填整数';
  if (to < from) return '止不能小于起';
  if (to - from + 1 > MAX_ITEMS) return `一批最多 ${MAX_ITEMS.toLocaleString('zh-CN')} 项`;
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

export function DeliverSheet(props: {
  readonly datasets: readonly { readonly id: string; readonly name?: string }[];
  readonly templates: readonly TemplateInfo[];
  readonly templateName?: string;
  readonly parameters?: ParameterValues;
  readonly output?: OutputSettings;
  readonly onClose: () => void;
  readonly onSubmitted: (batch: BatchView) => void;
}) {
  const [templateName, setTemplateName] = useState(() => props.templates.find((t) => t.name === props.templateName)?.name ?? props.templates[0]?.name ?? '');
  const template = props.templates.find((candidate) => candidate.name === templateName);
  const [parameters, setParameters] = useState<ParameterValues>(() => props.parameters ?? (template ? defaultParameters(template) : {}));
  const [output, setOutput] = useState<OutputSettings | undefined>(() => props.output ?? (template ? defaultOutput(template) : undefined));
  const integers = (template?.parameters ?? []).filter((parameter) => parameter.type === 'number' && parameter.constraints?.integer);
  const [sweep, setSweep] = useState<Sweep>();
  const [usage, setUsage] = useState<Usage>();
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<readonly Problem[]>();
  useEffect(() => { api.usage().then(setUsage, () => undefined); }, []);

  const chooseTemplate = (name: string) => {
    setTemplateName(name);
    const next = props.templates.find((candidate) => candidate.name === name);
    setParameters(next ? defaultParameters(next) : {});
    setOutput(next ? defaultOutput(next) : undefined);
    setSweep(undefined);
  };
  const values = sweep ? sweepValues(sweep) : undefined;
  const items = useMemo(() => {
    if (!template || !output || typeof values === 'string') return [];
    return props.datasets.flatMap((dataset) => (values ?? [undefined]).map((value) => ({
      id: value === undefined ? dataset.id : `${dataset.id}/${sweep!.name}=${value}`,
      dataset: { id: dataset.id },
      parameters: value === undefined ? parameters : { ...parameters, [sweep!.name]: value },
      output,
    })));
  }, [template, output, values, props.datasets, parameters, sweep]);
  const tooMany = items.length > MAX_ITEMS;
  const body = useMemo(() => ({ template: templateName, items }), [templateName, items]);
  // 幂等键跟着"这一次提交"走：内容不变时重试沿用它，改了内容就换一个。
  const key = useMemo(() => idempotencyKey(), [body]);
  const title = props.datasets.length === 1 ? props.datasets[0]!.name || props.datasets[0]!.id : `${props.datasets.length} 份数据集`;

  const submit = async () => {
    setBusy(true);
    setProblems(undefined);
    try {
      const batch = await api.submitBatch(body, key);
      remember(batch, title);
      props.onSubmitted(batch);
    } catch (error) { setProblems(problemsOf(error)); }
    finally { setBusy(false); }
  };

  return (
    <>
      <div className="scrim" onClick={props.onClose} />
      <section className="sheet" role="dialog" aria-modal="true" aria-labelledby="deliver-title">
        <div className="sheet-head">
          <div>
            <div className="eyebrow">出图 · 正式交付</div>
            <h2 id="deliver-title" style={{ fontSize: 24, marginTop: 4 }}>{title}</h2>
          </div>
          <button type="button" className="icon" aria-label="关闭出图" onClick={props.onClose}>×</button>
        </div>
        <div className="sheet-body">
          {props.templates.length === 0 && <p className="muted">没有用这个数据定义的模板。</p>}
          <div className="field">
            <label htmlFor="deliver-template">模板</label>
            <select id="deliver-template" value={templateName} onChange={(event) => chooseTemplate(event.target.value)}>
              {props.templates.map((candidate) => <option key={candidate.name} value={candidate.name}>{candidate.name}</option>)}
            </select>
          </div>
          {template && <ParameterPanel template={template} values={parameters} onChange={setParameters} />}
          {integers.length > 0 && (
            <div className="soft"><fieldset className="group">
              <legend>按参数出多张</legend>
              <label className="actions small">
                <input type="checkbox" checked={sweep !== undefined}
                  onChange={(event) => setSweep(event.target.checked ? { name: integers[0]!.name, from: String(integers[0]!.constraints?.min ?? 1), to: String(parameters[integers[0]!.name] ?? integers[0]!.constraints?.max ?? 1) } : undefined)} />
                按一个整数参数的范围，每个值出一张
              </label>
              {sweep && (
                <div className="field-row">
                  <div className="field">
                    <label htmlFor="sweep-name">参数</label>
                    <select id="sweep-name" value={sweep.name} onChange={(event) => setSweep({ ...sweep, name: event.target.value })}>
                      {integers.map((parameter) => <option key={parameter.name} value={parameter.name}>{parameter.displayName}</option>)}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="sweep-from">从</label>
                    <input id="sweep-from" type="text" inputMode="numeric" value={sweep.from} onChange={(event) => setSweep({ ...sweep, from: event.target.value })} />
                  </div>
                  <div className="field">
                    <label htmlFor="sweep-to">到</label>
                    <input id="sweep-to" type="text" inputMode="numeric" value={sweep.to} onChange={(event) => setSweep({ ...sweep, to: event.target.value })} />
                  </div>
                </div>
              )}
              {typeof values === 'string' && <p className="field-problems"><span className="severe" role="alert" style={{ color: 'var(--bad)' }}>{values}</span></p>}
            </fieldset></div>
          )}
          {template && output && <OutputPanel template={template} value={output} onChange={setOutput} />}
          <ErrorBox problems={problems} title="没有提交" />
        </div>
        <div className="sheet-foot">
          <div style={{ flex: '1 1 220px' }}>
            <div><strong>{items.length.toLocaleString('zh-CN')} 张</strong> 将正式交付{items.length ? ` · 预占 ${items.length.toLocaleString('zh-CN')} 张` : ''}</div>
            <div className="small muted">
              {usage ? `本月剩余 ${usage.images.remaining.toLocaleString('zh-CN')} 张；` : ''}每张都有出图记录，交付成功才计费，失败与取消的不计。
              {tooMany && <span style={{ color: 'var(--bad)' }}> 一批最多 {MAX_ITEMS.toLocaleString('zh-CN')} 项。</span>}
            </div>
          </div>
          <button type="button" onClick={props.onClose}>取消</button>
          <button type="button" className="primary" disabled={busy || items.length === 0 || tooMany} onClick={() => void submit()}>
            {busy ? '正在提交…' : `提交 ${items.length.toLocaleString('zh-CN')} 张`}
          </button>
        </div>
      </section>
    </>
  );
}

const STATUS: Readonly<Record<ItemStatus, string>> = { queued: '排队', running: '渲染中', delivered: '已交付', failed: '失败', notRun: '未执行' };
export const fileSafe = (text: string) => text.replace(/[^\p{L}\p{N}._=-]+/gu, '_').slice(0, 80);
/** 下载一项图片时的文件名：项序号加项 ID，如 0003-ds-m402_currentIndex=3.png；出图记录页同样命名。 */
export const imageFileName = (index: number, id: string, file: string) => `${String(index).padStart(4, '0')}-${fileSafe(id)}${file.slice(file.lastIndexOf('.'))}`;

/** 按参数出多张时，项 ID 是"数据集/参数=值"，格子上显示值。 */
const tileLabel = (item: BatchItem) => /=(-?\d+)$/.exec(item.id)?.[1] ?? String(item.index);

function useBatch(id: string) {
  const [batch, setBatch] = useState<BatchView>();
  const [problems, setProblems] = useState<readonly Problem[]>();
  useEffect(() => {
    let live = true, timer = 0;
    const poll = async () => {
      try {
        const view = await api.batch(id);
        if (!live) return;
        setBatch(view);
        setProblems(undefined);
        if (view.status === 'running') timer = window.setTimeout(() => void poll(), 1000);
      } catch (error) {
        if (!live) return;
        setProblems(problemsOf(error));
        timer = window.setTimeout(() => void poll(), 3000);
      }
    };
    void poll();
    return () => { live = false; window.clearTimeout(timer); };
  }, [id]);
  return { batch, setBatch, problems, setProblems };
}

function itemFile(batchId: string, item: BatchItem) {
  const file = item.files?.image;
  if (!file) return undefined;
  return { path: `/v1/batches/${batchId}/items/${item.index}/files/${file}`, filename: imageFileName(item.index, item.id, file) };
}

/** 选中的一项：图片、下载与问题说明。 */
function ItemDetail(props: { readonly batchId: string; readonly item: BatchItem; readonly onDownload: (path: string, filename: string) => void }) {
  const { item } = props, file = itemFile(props.batchId, item);
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!file) { setUrl(undefined); return undefined; }
    let live = true, made: string | undefined;
    api.download(file.path).then((blob) => { made = URL.createObjectURL(blob); if (live) setUrl(made); }, () => undefined);
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [file?.path]);
  return (
    <div className="item-detail" data-testid="item-detail">
      {url && <img src={url} alt={`第 ${item.index} 项 ${item.id} 的图片`} />}
      <div className="item-info">
        <div style={{ flex: '1 1 200px' }}>
          <div style={{ fontWeight: 600 }}>第 {item.index} 项 <span className={`chip ${item.status === 'delivered' ? 'ok' : item.status === 'failed' ? 'bad' : item.status === 'notRun' ? 'warn' : ''}`}>{STATUS[item.status]}</span></div>
          <div className="mono muted">{item.id}</div>
        </div>
        {file && <button type="button" className="small quiet" onClick={() => props.onDownload(file.path, file.filename)}>下载图片</button>}
      </div>
      {item.problems?.length ? (
        <ul className="plain" style={{ padding: '0 14px 12px' }}>
          {item.problems.map((problem, index) => (
            <li key={index} className={problem.level}>{problem.level === 'severe' ? '严重' : '提示'} · {locationText(problem)}：{problem.message} <code className="muted">{problem.code}</code></li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** 批次进度：头部、格子、选中项与操作；侧栏与整页共用。 */
function BatchProgress(props: { readonly id: string; readonly layout: 'sheet' | 'page'; readonly onClose?: () => void }) {
  const { batch, setBatch, problems, setProblems } = useBatch(props.id);
  const [confirming, setConfirming] = useState(false);
  const [selected, setSelected] = useState<number>();
  const [downloadProblems, setDownloadProblems] = useState<readonly Problem[]>();
  const cancel = async () => {
    setConfirming(false);
    try { setBatch(await api.cancelBatch(props.id)); } catch (error) { setProblems(problemsOf(error)); }
  };
  const download = async (path: string, filename: string) => {
    setDownloadProblems(undefined);
    try { saveBlob(await api.download(path), filename); } catch (error) { setDownloadProblems(problemsOf(error)); }
  };
  const finished = batch?.status === 'finished', cancelled = Boolean(batch?.cancelRequested);
  const count = (status: ItemStatus) => batch?.items.filter((item) => item.status === status).length ?? 0;
  const total = Math.max(batch?.progress.total ?? 1, 1);
  const item = batch?.items.find((candidate) => candidate.index === selected)
    ?? (finished ? batch?.items.find((candidate) => candidate.status === 'failed') ?? batch?.items[0] : undefined);
  const stateText = finished ? (cancelled ? '已取消' : batch!.summary.failed ? '部分失败' : '已完成') : cancelled ? '正在取消' : '进行中';
  const tone = finished ? (cancelled ? 'warn' : batch!.summary.failed ? 'warn' : 'ok') : 'accent';

  const head = (
    <div className={props.layout === 'sheet' ? 'sheet-head' : 'title-row'}>
      <div>
        <div className="eyebrow">出图任务 <code>{props.id.slice(0, 8)}</code>{batch && ` · 提交于 ${new Date(batch.createdAt).toLocaleString('zh-CN')}`}</div>
        <h2 id="batch-title" style={{ fontSize: props.layout === 'sheet' ? 24 : 30, marginTop: 4 }}>
          {batch?.template ?? '出图任务'} {batch && <span className={`chip ${tone}`} data-testid="batch-status" style={{ verticalAlign: 'middle' }}>{stateText}</span>}
        </h2>
      </div>
      {props.onClose && <button type="button" className="icon" aria-label="关闭出图任务" onClick={props.onClose}>×</button>}
    </div>
  );
  const body = (
    <>
      <ErrorBox problems={problems} title="读不到出图任务" />
      {batch && (
        <>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
              <span className="big-number">{batch.summary.delivered} <span className="muted" style={{ fontSize: 16, fontWeight: 400 }}>/ {batch.progress.total} 已交付</span></span>
              <span className="muted small">已结束 {batch.progress.completed} 项</span>
            </div>
            <div className="progress" role="progressbar" aria-label="交付进度" aria-valuemin={0} aria-valuemax={batch.progress.total} aria-valuenow={batch.progress.completed} style={{ marginTop: 10 }}>
              <div className="done" style={{ width: `${(count('delivered') / total) * 100}%` }} />
              <div className="failed" style={{ width: `${(count('failed') / total) * 100}%` }} />
              <div className="skipped" style={{ width: `${(count('notRun') / total) * 100}%` }} />
            </div>
            <div className="legend" style={{ marginTop: 10 }}>
              <span><span className="swatch" style={{ background: 'var(--ok)' }} />已交付 {count('delivered')}</span>
              <span><span className="swatch" style={{ background: 'var(--mark)' }} />渲染中 {count('running')}</span>
              <span><span className="swatch" style={{ background: 'var(--sunken)', border: '1px solid var(--field)' }} />排队 {count('queued')}</span>
              <span><span className="swatch" style={{ background: 'var(--bad)' }} />失败 {count('failed')}</span>
              {count('notRun') > 0 && <span><span className="swatch" style={{ background: 'var(--warn)' }} />未执行 {count('notRun')}</span>}
            </div>
          </div>
          {batch.problems.length > 0 && <ul className="plain small muted">{batch.problems.map((problem, index) => <li key={index}>{problem.message}</li>)}</ul>}
          <div>
            <h3 style={{ marginBottom: 10 }}>逐项结果</h3>
            <ul className="tiles" aria-label="逐项结果">
              {batch.items.map((entry) => (
                <li key={entry.index}>
                  <button type="button" className={`tile ${entry.status}`} data-testid="batch-item" data-status={entry.status} data-id={entry.id}
                    aria-pressed={entry.index === item?.index} aria-label={`第 ${entry.index} 项 ${entry.id}：${STATUS[entry.status]}`} onClick={() => setSelected(entry.index)}>
                    <span className="n">{tileLabel(entry)}</span>
                    <span className="s">{STATUS[entry.status]}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          {item && <ItemDetail batchId={props.id} item={item} onDownload={(path, filename) => void download(path, filename)} />}
          <ErrorBox problems={downloadProblems} title="下载失败" />
        </>
      )}
    </>
  );
  const foot = batch && (
    <div className={props.layout === 'sheet' ? 'sheet-foot' : 'actions'} style={props.layout === 'page' ? { marginTop: 20 } : undefined}>
      {!finished && !cancelled && !confirming && <button type="button" className="danger" onClick={() => setConfirming(true)}>取消批次</button>}
      {confirming && (
        <span className="confirm">
          还没开始的项不再交付，正在渲染的会被结束；它们都不计费。
          <button type="button" className="danger small" onClick={() => void cancel()}>确认取消</button>
          <button type="button" className="small" onClick={() => setConfirming(false)}>不取消</button>
        </span>
      )}
      <span style={{ flex: 1 }} />
      {finished && batch.summary.delivered > 0
        ? <button type="button" className="primary" onClick={() => void download(`/v1/batches/${props.id}/images.zip`, `batch-${props.id}-images.zip`)}>下载整批图片（zip）</button>
        : <span className="small muted">{finished ? '没有交付成功的图片' : '整批压缩包在批次结束后生成'}</span>}
    </div>
  );

  if (props.layout === 'page') return <section className="page" aria-labelledby="batch-title">{head}<div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>{body}</div>{foot}</section>;
  return (
    <>
      <div className="scrim" onClick={props.onClose} />
      <section className="sheet" role="dialog" aria-modal="true" aria-labelledby="batch-title">
        {head}
        <div className="sheet-body">{body}</div>
        {foot}
      </section>
    </>
  );
}

export const BatchSheet = (props: { readonly id: string; readonly onClose: () => void }) => <BatchProgress id={props.id} layout="sheet" onClose={props.onClose} />;

export function BatchPage(props: { readonly id: string }) {
  return (
    <>
      <nav className="crumbs page" aria-label="位置" style={{ paddingBottom: 0 }}><a href={href(['datasets'])}>数据集</a><span aria-hidden="true">/</span><span>出图任务</span></nav>
      <BatchProgress id={props.id} layout="page" />
    </>
  );
}
