/**
 * Excel 导入（票据 13，M283–M286）：与出图侧栏同样在侧栏里进行。
 * 选模板、对外参数与尺寸，按模板的数据定义下载空白表，上传填好的 .xlsx；服务端答导入预览——逐行能不能提交、问题定位到工作表、行与列。
 * 确认后把能提交的行作为一批正式交付（POST /v1/batches，带幂等键），有问题的行不进批次；随后与出图一样看进度。
 */
import { useEffect, useMemo, useState } from 'react';
import { api, saveBlob } from '../api.js';
import { defaultOutput, defaultParameters, OutputPanel, ParameterPanel, type ParameterValues } from '../components/parameters.js';
import { ErrorBox, levelText } from '../components/problems.js';
import { problemsOf } from '../hooks.js';
import type { BatchView, ExcelImport, ImportProblem, OutputSettings, Problem, StaticSchemaSummary, TemplateInfo, Usage, WorkbookCell } from '../types.js';
import { idempotencyKey, remember } from './deliver.js';
import { sameSchema, schemaText } from './templates.js';

/** 文件内容的 base64：分段转换，几 MB 的文件也不会撑爆参数个数。 */
async function base64Of(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** 单元格的写法：主表只写列号与行号，别的表带上表名；有表头时附上。 */
function cellText(cell: WorkbookCell | undefined, main: string): string {
  if (!cell) return '整份';
  const where = `${cell.sheet === main ? '' : `${cell.sheet} `}${cell.column ?? '第 '}${cell.row}${cell.column ? '' : ' 行'}`;
  return cell.header ? `${where}（${cell.header}）` : where;
}

function ProblemLines(props: { readonly problems: readonly ImportProblem[]; readonly main: string }) {
  return (
    <ul className="field-problems">
      {props.problems.map((problem, index) => (
        <li key={index} className={problem.level}>
          <span className="mono">{cellText(problem.cell, props.main)}</span> {levelText(problem)}：{problem.message}
        </li>
      ))}
    </ul>
  );
}

export function ImportSheet(props: {
  readonly templates: readonly TemplateInfo[];
  readonly schemas: readonly StaticSchemaSummary[];
  readonly templateName?: string;
  readonly onClose: () => void;
  readonly onSubmitted: (batch: BatchView) => void;
}) {
  // 只有数据定义在本租户的模板能导入（引擎内置的数据定义没有字段）。
  const usable = props.templates.filter((candidate) => props.schemas.some((schema) => sameSchema(schema, candidate.base)));
  const [templateName, setTemplateName] = useState(() => usable.find((t) => t.name === props.templateName)?.name ?? usable[0]?.name ?? '');
  const template = usable.find((candidate) => candidate.name === templateName);
  const [parameters, setParameters] = useState<ParameterValues>(() => (template ? defaultParameters(template) : {}));
  const [output, setOutput] = useState<OutputSettings | undefined>(() => (template ? defaultOutput(template) : undefined));
  const [file, setFile] = useState<{ readonly name: string; readonly base64: string }>();
  const [preview, setPreview] = useState<ExcelImport>();
  const [reading, setReading] = useState(false);
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [problems, setProblems] = useState<readonly Problem[]>();
  const [submitProblems, setSubmitProblems] = useState<readonly Problem[]>();
  const [busy, setBusy] = useState(false);
  const [usage, setUsage] = useState<Usage>();
  useEffect(() => { api.usage().then(setUsage, () => undefined); }, []);

  const chooseTemplate = (name: string) => {
    setTemplateName(name);
    const next = usable.find((candidate) => candidate.name === name);
    setParameters(next ? defaultParameters(next) : {});
    setOutput(next ? defaultOutput(next) : undefined);
  };
  const chooseFile = async (chosen: File | undefined) => {
    setProblems(undefined);
    // 选完就清空文件框：改好表格后再选同一个文件也能重新导入。
    if (!chosen) return;
    // 读不了新选的文件时丢掉上一份的预览，免得错把上一份提交出去。
    try { setFile({ name: chosen.name, base64: await base64Of(chosen) }); } catch (error) { setFile(undefined); setProblems(problemsOf(error)); }
  };

  // 换文件或换模板时重新导入；对外参数与尺寸只写进批量请求，提交时按当前的值填。
  useEffect(() => {
    setPreview(undefined);
    if (!file || !template || !output) return undefined;
    let live = true;
    setReading(true);
    setProblems(undefined);
    api.importExcel({ template: template.name, workbook: file.base64, parameters, output })
      .then((reply) => { if (live) setPreview(reply); }, (error) => { if (live) setProblems(problemsOf(error)); })
      .finally(() => { if (live) setReading(false); });
    return () => { live = false; };
  }, [file, template?.name]);

  const batch = useMemo(() => (preview?.batch && output
    ? { ...preview.batch, items: preview.batch.items.map((item) => ({ ...item, parameters, output })) } : undefined), [preview, parameters, output]);
  // 幂等键跟着"这一次提交"走：内容不变时重试沿用它，改了内容就换一个。
  const key = useMemo(() => idempotencyKey(), [batch]);
  const count = batch?.items.length ?? 0;

  const downloadBlank = async () => {
    if (!template?.base) return;
    setProblems(undefined);
    const { name, version } = template.base;
    try { saveBlob(await api.blankWorkbook(name, version), `${name}-v${version}.xlsx`); } catch (error) { setProblems(problemsOf(error)); }
  };
  const submit = async () => {
    if (!batch) return;
    setBusy(true);
    setSubmitProblems(undefined);
    try {
      const view = await api.submitBatch(batch, key);
      remember(view, file?.name ?? 'Excel 导入');
      props.onSubmitted(view);
    } catch (error) { setSubmitProblems(problemsOf(error)); }
    finally { setBusy(false); }
  };
  const rows = preview?.rows.filter((row) => !onlyProblems || row.problems.length > 0) ?? [];

  return (
    <>
      <div className="scrim" onClick={props.onClose} />
      <section className="sheet wide" role="dialog" aria-modal="true" aria-labelledby="import-title">
        <div className="sheet-head">
          <div>
            <div className="eyebrow">Excel 导入 · 正式交付</div>
            <h2 id="import-title" style={{ fontSize: 24, marginTop: 4 }}>{file?.name ?? '从 Excel 导入一批数据'}</h2>
          </div>
          <button type="button" className="icon" aria-label="关闭导入" onClick={props.onClose}>×</button>
        </div>
        <div className="sheet-body">
          {usable.length === 0 && <p className="muted">没有可以导入的模板：模板的数据定义要在本租户里。</p>}
          <div className="field">
            <label htmlFor="import-template">模板</label>
            <select id="import-template" value={templateName} onChange={(event) => chooseTemplate(event.target.value)}>
              {usable.map((candidate) => <option key={candidate.name} value={candidate.name}>{candidate.name}（{schemaText(candidate.base, props.schemas)}）</option>)}
            </select>
          </div>
          <div className="soft small">
            一行一个渲染项，表头写字段的显示名称；列表写在一格里，用顿号、逗号、分号或换行分开；站点这类引用列表写在另一张表，用关联值对应主表的行。
            {template?.base && <> <button type="button" className="small quiet" onClick={() => void downloadBlank()}>下载空白表</button></>}
          </div>
          {template && <ParameterPanel template={template} values={parameters} onChange={setParameters} />}
          {template && output && <OutputPanel template={template} value={output} onChange={setOutput} />}
          <div className="field">
            <label htmlFor="import-file">Excel 文件（.xlsx）</label>
            <input id="import-file" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(event) => { void chooseFile(event.target.files?.[0]); event.target.value = ''; }} />
          </div>
          <ErrorBox problems={problems} title="读不了这份文件" />
          {reading && <p className="muted" role="status">正在读取…</p>}
          {preview && (
            <div data-testid="import-preview" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <p data-testid="import-summary" style={{ margin: 0 }}>
                <strong>主表"{preview.sheet}"共 {preview.summary.rows} 行</strong>：可提交 {preview.summary.accepted} 行
                {preview.summary.rejected ? `，有严重问题的 ${preview.summary.rejected} 行不进批次` : ''}
              </p>
              {preview.problems.length > 0 && (
                <div className="soft" data-testid="import-file-problems"><ProblemLines problems={preview.problems} main={preview.sheet} /></div>
              )}
              {preview.rows.length > 0 && (
                <>
                  <label className="actions small">
                    <input type="checkbox" checked={onlyProblems} onChange={(event) => setOnlyProblems(event.target.checked)} />只看有问题的行
                  </label>
                  <div className="table-box">
                    <table className="table">
                      <thead><tr><th>行</th><th>渲染项 ID</th><th>状态</th><th>问题</th></tr></thead>
                      <tbody>
                        {rows.map((row) => (
                          <tr key={row.row} data-testid="import-row" data-row={row.row} data-status={row.status}>
                            <td className="mono">{row.row}</td>
                            <td className="mono">{row.itemId}</td>
                            <td><span className={`chip ${row.status === 'accepted' ? 'ok' : 'bad'}`}>{row.status === 'accepted' ? '可提交' : '不提交'}</span></td>
                            <td>{row.problems.length ? <ProblemLines problems={row.problems} main={preview.sheet} /> : <span className="muted">—</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          )}
          <ErrorBox problems={submitProblems} title="没有提交" />
        </div>
        <div className="sheet-foot">
          <div style={{ flex: '1 1 220px' }}>
            <div><strong>{count.toLocaleString('zh-CN')} 张</strong> 将正式交付{count ? ` · 预占 ${count.toLocaleString('zh-CN')} 张` : ''}</div>
            <div className="small muted">{usage ? `本月剩余 ${usage.images.remaining.toLocaleString('zh-CN')} 张；` : ''}有问题的行不进批次，改好表格再导入一次即可。</div>
          </div>
          <button type="button" onClick={props.onClose}>取消</button>
          <button type="button" className="primary" disabled={busy || count === 0} onClick={() => void submit()}>
            {busy ? '正在提交…' : `提交 ${count.toLocaleString('zh-CN')} 张`}
          </button>
        </div>
      </section>
    </>
  );
}
