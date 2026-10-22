/**
 * 资源（票据 14，M301）：本租户的图片与字体资源（票据 10，M271）。
 * - 客户管理员与操作员都能上传新资源，从 v1 开始；资源 ID 与种类创建后不变；
 * - 替换已有资源只给客户管理员，分两步（M152）：先检查影响——列出直接引用它的模板与数据集、字体配置——再确认应用。
 *   检查报告原样交回服务端，按报告里的版本提交；检查之后工作区或资源变了，服务端拒绝（409），要重新检查。
 */
import { useEffect, useState } from 'react';
import { api, imageBlob } from '../api.js';
import { forgetResources, thumbnail } from '../components/image-picker.js';
import { ErrorBox, ProblemList } from '../components/problems.js';
import { problemsOf, useLoad } from '../hooks.js';
import type { Identity, Problem, ReplacementCheck, ResourceInfo } from '../types.js';

const KIND: Readonly<Record<ResourceInfo['kind'], string>> = { image: '图片', font: '字体' };
const ACCEPT: Readonly<Record<ResourceInfo['kind'], string>> = { image: 'image/png,image/jpeg,image/webp,image/svg+xml', font: '.otf,.ttf,.woff,.woff2,font/*' };
/** 引用的种类（引擎的 ResourceReferenceKind）。 */
const REFERENCE: Readonly<Record<string, string>> = {
  templateFixed: '模板里写定的', stateStyle: '模板的状态样式', parameterDefault: '对外参数的缺省值', derivedValue: '派生变量', callArgument: '子模板调用的参数', datasetImage: '数据集的图片字段',
};
const CONFIGURATION: Readonly<Record<string, string>> = { fallbackFonts: '缺字时的后备字体', svgFonts: 'SVG 用的字体' };

const byteText = (bytes: number) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);
const currentOf = (resource: ResourceInfo) => resource.versions?.find((version) => version.version === resource.currentVersion);

function Thumb(props: { readonly resource: ResourceInfo }) {
  const [url, setUrl] = useState<string>();
  const { resource } = props;
  useEffect(() => {
    if (resource.kind !== 'image') return undefined;
    let live = true;
    thumbnail(resource).then((value) => { if (live) setUrl(value); }, () => undefined);
    return () => { live = false; };
  }, [resource.id, resource.currentVersion, resource.kind]);
  if (resource.kind === 'font') return <span className="thumb font-thumb" aria-hidden="true">Aa</span>;
  return url ? <img className="thumb" src={url} alt="" /> : <span className="thumb thumb-missing" aria-hidden="true" />;
}

export function ResourcesPage(props: { readonly identity: Identity }) {
  const loaded = useLoad(() => api.resources(), 'resources');
  const [notice, setNotice] = useState<string>();
  const [replacing, setReplacing] = useState<ResourceInfo>();
  const canReplace = props.identity.role === 'admin';
  const changed = (message: string) => { forgetResources(); setNotice(message); loaded.reload(); };

  return (
    <section className="page">
      <div className="title-row">
        <div>
          <h1>资源</h1>
          <p className="lede">模板与数据集里用到的图片与字体。上传的新资源随即可以在数据集的图片字段里选。{canReplace
            ? '替换已有资源时先检查影响，确认后才生效，旧版本保留，已有的出图记录不受影响。'
            : '替换已有资源由客户管理员办理。'}</p>
        </div>
      </div>
      {notice && <p className="notice" role="status">{notice}</p>}
      <Upload onUploaded={(created) => changed(`已上传 ${created.id}（v${created.version}）`)} />
      <ErrorBox problems={loaded.problems} title="读不到资源" />
      {loaded.data && (
        <div className="card" style={{ padding: '8px 12px', marginTop: 16 }}>
          <table className="table">
            <thead><tr><th><span className="visually-hidden">缩略图</span></th><th>资源 ID</th><th>种类</th><th>当前版本</th><th>大小</th><th><span className="visually-hidden">操作</span></th></tr></thead>
            <tbody>
              {loaded.data.resources.length === 0 && <tr><td colSpan={6} className="muted">还没有资源。</td></tr>}
              {loaded.data.resources.map((resource) => {
                const current = currentOf(resource);
                return (
                  <tr key={resource.id} data-testid="resource-row" data-id={resource.id}>
                    <td style={{ width: 60 }}><Thumb resource={resource} /></td>
                    <td className="mono">{resource.id}</td>
                    <td>{KIND[resource.kind]}</td>
                    <td>v{resource.currentVersion}{(resource.versions?.length ?? 1) > 1 && <span className="muted small">（共 {resource.versions!.length} 个版本）</span>}</td>
                    <td>{current ? byteText(current.byteLength) : '—'}</td>
                    <td className="row-actions">
                      {canReplace && <button type="button" className="small quiet" aria-label={`替换 ${resource.id}`} onClick={() => { setNotice(undefined); setReplacing(resource); }}>替换…</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {replacing && <ReplaceSheet resource={replacing} onClose={() => setReplacing(undefined)}
        onReplaced={(version) => { setReplacing(undefined); changed(`已把 ${replacing.id} 替换为 v${version}`); }} />}
    </section>
  );
}

function Upload(props: { readonly onUploaded: (created: { readonly id: string; readonly version: number }) => void }) {
  const [kind, setKind] = useState<ResourceInfo['kind']>('image');
  const [id, setId] = useState('');
  const [file, setFile] = useState<File>();
  // 上传之后换一个新的文件框：再选同一个文件也能触发选择。
  const [picker, setPicker] = useState(0);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<readonly Problem[]>();
  const upload = async () => {
    if (!file) return;
    setBusy(true);
    setProblems(undefined);
    try {
      const created = await api.uploadResource(kind, file, id.trim() || undefined);
      setId('');
      setFile(undefined);
      setPicker((value) => value + 1);
      props.onUploaded(created);
    } catch (error) { setProblems(problemsOf(error)); }
    finally { setBusy(false); }
  };
  return (
    <form className="card" aria-labelledby="upload-title" onSubmit={(event) => { event.preventDefault(); void upload(); }}>
      <h2 id="upload-title">上传新资源</h2>
      <div className="fields">
        <div className="field">
          <label htmlFor="upload-kind">种类</label>
          <select id="upload-kind" value={kind} onChange={(event) => { setKind(event.target.value as ResourceInfo['kind']); setFile(undefined); setPicker((value) => value + 1); }}>
            <option value="image">图片（PNG、JPEG、WebP、SVG）</option>
            <option value="font">字体（OTF、TTF）</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="upload-id">资源 ID（可不填）</label>
          <input id="upload-id" type="text" className="mono" value={id} placeholder="不填时自动生成" onChange={(event) => setId(event.target.value)} />
          <span className="hint">字母、数字、- 与 _，模板与数据集里写成 res:资源ID</span>
        </div>
        <div className="field">
          <span className="field-label">文件</span>
          <div className="image-actions">
            <label className="button small quiet">
              选择文件…
              <input key={picker} type="file" accept={ACCEPT[kind]} className="visually-hidden" aria-label="选择文件" disabled={busy} onChange={(event) => setFile(event.target.files?.[0])} />
            </label>
            <span className="small muted">{file ? `${file.name} · ${byteText(file.size)}` : '还没选文件'}</span>
          </div>
        </div>
      </div>
      <div className="actions" style={{ marginTop: 16 }}>
        <button type="submit" className="primary" disabled={!file || busy}>{busy ? '正在上传…' : '上传'}</button>
      </div>
      <ErrorBox problems={problems} title="没有上传" />
    </form>
  );
}

/** 替换一个资源：选新内容 → 检查影响 → 确认替换。换了文件要重新检查。 */
function ReplaceSheet(props: { readonly resource: ResourceInfo; readonly onClose: () => void; readonly onReplaced: (version: number) => void }) {
  const { resource } = props, current = currentOf(resource);
  const [file, setFile] = useState<File>();
  const [preview, setPreview] = useState<string>();
  /** 检查报告与它检查的那个文件：换了文件，旧报告就不算数。 */
  const [report, setReport] = useState<{ readonly file: File; readonly check: ReplacementCheck; readonly problems: readonly Problem[] }>();
  const [busy, setBusy] = useState<'check' | 'apply'>();
  const [problems, setProblems] = useState<readonly Problem[]>();
  useEffect(() => {
    if (!file || resource.kind !== 'image') { setPreview(undefined); return undefined; }
    let made: string | undefined, live = true;
    file.arrayBuffer().then((bytes) => { made = URL.createObjectURL(imageBlob(bytes)); if (live) setPreview(made); }, () => undefined);
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [file, resource.kind]);

  const check = async () => {
    if (!file) return;
    setBusy('check');
    setProblems(undefined);
    setReport(undefined);
    try { setReport({ file, ...(await api.checkReplacement(resource.id, file)) }); } catch (error) { setProblems(problemsOf(error)); }
    finally { setBusy(undefined); }
  };
  const apply = async () => {
    if (!checked) return;
    setBusy('apply');
    setProblems(undefined);
    try { props.onReplaced((await api.applyReplacement(resource.id, checked.check)).version); }
    catch (error) {
      // 没替换成就丢掉报告、重新检查：最常见的是报告过期（检查之后工作区或资源变了，409）。
      setReport(undefined);
      setProblems(problemsOf(error));
    } finally { setBusy(undefined); }
  };
  // 检查期间换了文件时，晚到的报告属于旧文件，不显示也不能拿去应用。
  const checked = report?.file === file ? report : undefined;
  const references = checked?.check.impact.references ?? [], configuration = checked?.check.impact.configuration ?? [];

  return (
    <>
      <div className="scrim" onClick={props.onClose} />
      <section className="sheet" role="dialog" aria-modal="true" aria-labelledby="replace-title">
        <div className="sheet-head">
          <div>
            <div className="eyebrow">资源 · {KIND[resource.kind]} · 当前 v{resource.currentVersion}{current ? ` · ${byteText(current.byteLength)}` : ''}</div>
            <h2 id="replace-title" style={{ fontSize: 24, marginTop: 4 }}>替换 {resource.id}</h2>
          </div>
          <button type="button" className="icon" aria-label="关闭替换" onClick={props.onClose}>×</button>
        </div>
        <div className="sheet-body">
          <p className="muted small">替换得到 v{resource.currentVersion + 1}。引用 res:{resource.id} 的模板与数据集之后出图都用新内容；旧版本保留，已有的出图记录照样能重放。</p>
          <div className="compare">
            <figure><Thumb resource={resource} /><figcaption className="small muted">当前 v{resource.currentVersion}</figcaption></figure>
            {preview && <figure><img className="thumb" src={preview} alt="新内容" /><figcaption className="small muted">新内容</figcaption></figure>}
          </div>
          <div className="image-actions">
            <label className="button small quiet">
              {file ? '换一个文件…' : '选择新内容…'}
              <input type="file" accept={ACCEPT[resource.kind]} className="visually-hidden" aria-label="新内容" disabled={busy !== undefined}
                onChange={(event) => { setFile(event.target.files?.[0]); setReport(undefined); setProblems(undefined); event.target.value = ''; }} />
            </label>
            <span className="small muted">{file ? `${file.name} · ${byteText(file.size)}` : '还没选文件'}</span>
            <button type="button" className="small" disabled={!file || busy !== undefined} onClick={() => void check()}>{busy === 'check' ? '正在检查…' : '检查影响'}</button>
          </div>
          {checked && (
            <section className="soft" aria-labelledby="impact-title">
              <h3 id="impact-title">受影响的位置 {references.length} 处</h3>
              {references.length === 0 && configuration.length === 0 && <p className="small muted">没有模板或数据集直接引用它，替换不影响现有的出图。</p>}
              {references.length > 0 && (
                <ul className="plain impact">
                  {references.map((reference, index) => (
                    <li key={index} data-testid="impact-reference" data-kind={reference.kind} data-document={reference.document} data-path={reference.path}>
                      <strong>{reference.source.startsWith('dataset:') ? '数据集' : '模板'} {reference.document}</strong>
                      <span className="muted small"> · {REFERENCE[reference.kind] ?? reference.kind}</span>
                      <div className="mono muted">{reference.path}</div>
                    </li>
                  ))}
                </ul>
              )}
              {configuration.length > 0 && (
                <p className="small" style={{ color: 'var(--warn)' }}>服务的字体配置也用到它：{configuration.map((entry) => `${CONFIGURATION[entry.kind] ?? entry.kind}（${entry.path}）`).join('、')}。</p>
              )}
              <p className="small muted">{checked.check.impact.scope}</p>
              <ProblemList problems={checked.problems} label="检查的提示" />
            </section>
          )}
          <ErrorBox problems={problems} title="没有替换" />
        </div>
        <div className="sheet-foot">
          <span className="small muted" style={{ flex: '1 1 220px' }}>{checked ? '确认后立即生效。' : '先选新内容并检查影响，才能替换。'}</span>
          <button type="button" onClick={props.onClose}>取消</button>
          <button type="button" className="primary" disabled={!checked || busy !== undefined} onClick={() => void apply()}>{busy === 'apply' ? '正在替换…' : '确认替换'}</button>
        </div>
      </section>
    </>
  );
}
