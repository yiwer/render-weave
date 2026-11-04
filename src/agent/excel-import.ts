/** 将完成的 Excel 提取包重新独立核查，固定为正式审核轮次。 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, realpath, lstat, readdir, writeFile, copyFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorkspaceDocuments } from '../workspace.js';
import { openResourceRepository } from '../resources.js';
import { withLocalAccess } from '../local-access.js';
import { canonical } from './diff.js';
import { checkCandidates } from './candidates.js';
import { captureResources } from './content-identity.js';
import { claimExecution, writeAtomicJson } from './execution.js';
import { readReview } from './review.js';
import { readExcelEvidence, replayExcelCorrections, type ExcelEvidence } from './excel-evidence.js';
import { AgentUsageError, sha256, workspaceFingerprint } from './round-files.js';
import type { RoundOutcome, RoundRecord, RoundUsage } from './run.js';

export interface ImportExcelOptions { from: string; workspace: string; out: string; resources?: string; previous?: string; python?: string }
export async function importExcelRound(options: ImportExcelOptions): Promise<{ roundDir: string; candidates: number; corrections: ExcelEvidence['corrections'] }> {
  const root = await realpath(options.from), out = resolve(options.out), workspaceDir = await realpath(options.workspace);
  const bytes = async (file: string, limit = 4*1024*1024) => {
    const path = join(root, file), actual = await realpath(path), rel = relative(root, actual);
    if (rel.startsWith('..') || resolve(root, rel) !== actual || (await lstat(path)).isSymbolicLink()) throw new AgentUsageError('提取包文件越界或为链接');
    const data = await readFile(actual); if (data.length > limit) throw new AgentUsageError(`提取包文件过大：${file}`); return data;
  };
  const result = JSON.parse((await bytes('result.json')).toString('utf8'));
  if (result.passed !== true) {
    const codes = (Array.isArray(result.attempts) ? result.attempts : []).flatMap((a: any) => Array.isArray(a.mechanical?.issues) ? a.mechanical.issues : [])
      .map((p: any) => typeof p.code === 'string' ? p.code.slice(0, 100) : 'unknown').slice(0, 12);
    throw new AgentUsageError(`提取包尚未完成，不能进入审核；请查看 result.json 和各次尝试的检查报告${codes.length ? `（${[...new Set(codes)].join('、')}）` : ''}`);
  }
  let submitted;
  try { submitted = JSON.parse((await bytes('submission.json')).toString('utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new AgentUsageError('提取包缺少 submission.json，模型尚未交回完整成果，不能进入审核');
    throw error;
  }
  const start = JSON.parse((await bytes('start.json')).toString('utf8'));
  if (!result.passed || !/^attempt-[0-9]{2}$/.test(submitted.attemptId) || typeof submitted.notes !== 'string' || !Array.isArray(submitted.pending) || submitted.pending.some((p: unknown) => typeof p !== 'string')) throw new AgentUsageError('提取包尚未完成或交回格式非法');
  const attempt = submitted.attemptId;
  const captured = new Map<string, Buffer>();
  for (const [name, file] of Object.entries({ 'source.xlsx': 'inputs/source.xlsx', 'brief.md': 'inputs/brief.md', 'target.json': 'inputs/target.json', 'submission.json': 'submission.json', 'plan.json': `${attempt}/plan.json`, 'candidate.json': `${attempt}/candidate.json`, 'transform.py': `${attempt}/transform.py` })) captured.set(name, await bytes(file, name.endsWith('xlsx') ? 16*1024*1024 : 4*1024*1024));
  const target = JSON.parse(captured.get('target.json')!.toString('utf8'));
  const bundle = JSON.parse(captured.get('candidate.json')!.toString('utf8'));
  const plan = JSON.parse(captured.get('plan.json')!.toString('utf8'));
  if (!Array.isArray(bundle.datasets) || !bundle.datasets.length || !Array.isArray(bundle.sources) || !target.selected?.compiled) throw new AgentUsageError('提取包缺少定义、候选或来源');
  await mkdir(dirname(out), { recursive: true }); await mkdir(out);
  const execution = await claimExecution(out, new Date().toISOString());
  try {
    for (const folder of ['excel', 'snapshot', 'agent', 'candidates', 'logs', 'empty-resources']) await mkdir(join(out, folder));
    for (const [name, data] of captured) await writeFile(join(out, 'excel', name), data, { flag: 'wx' });
    await writeFile(join(out, 'empty-resources/resources.json'), '{"resources":[]}');
    const snapshot = join(out, 'snapshot');
    await withLocalAccess([workspaceDir], async () => {
      for (const file of (await readdir(workspaceDir)).filter(f => f.endsWith('.json'))) await copyFile(join(workspaceDir, file), join(snapshot, file));
    });
    const resourceSource = options.resources ? await realpath(options.resources) : join(out, 'empty-resources');
    const resourceSnapshot = await captureResources(out, resourceSource);
    const resources = await openResourceRepository(join(out, resourceSnapshot.directory));
    if (resources.problems.some(p => p.level === 'severe')) throw new AgentUsageError('固定资源副本不合格');
    const workspace = { ...await loadWorkspaceDocuments(snapshot), resources: resources.repository };
    if (workspace.problems.some(p => p.level === 'severe')) throw new AgentUsageError('工作空间文档不合格');
    for (const fixed of target.staticSchemas) {
      const now = workspace.staticSchemas.find(s => s.ref.name === fixed.ref.name && s.ref.version === fixed.ref.version);
      if (!now || canonical(now.compiled) !== canonical(fixed.compiled) || canonical(now.definition) !== canonical(fixed.definition)) throw new AgentUsageError('工作空间数据定义与提取时不同，请重新提取');
    }
    const selected = workspace.staticSchemas.find(s => s.ref.name === target.selected.ref.name && s.ref.version === target.selected.ref.version);
    if (!selected?.compiled || canonical(selected.compiled) !== canonical(target.selected.compiled)) throw new AgentUsageError('选定 staticSchema 与工作空间不一致');
    // 固定的宿主校验程序只读原件与 JSON，永不执行 transform.py。
    await new Promise<void>((done, fail) => {
      const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|HOME|LANG|LC_ALL)$/i.test(name)));
      const child = spawn(options.python ?? 'python', ['-E', '-s', '-X', 'utf8', fileURLToPath(new URL('../../agent/excel/verify.py', import.meta.url)), join(out, 'excel')], { windowsHide: true, env, stdio: ['ignore', 'ignore', 'pipe'] });
      let error = ''; const timer = setTimeout(() => { child.kill(); fail(new AgentUsageError('工作簿校验超时')); }, 30000);
      child.stderr.on('data', d => { if (error.length < 12000) error += d.toString('utf8'); });
      child.on('error', e => { clearTimeout(timer); fail(new AgentUsageError(e.message)); });
      child.on('close', code => { clearTimeout(timer); code === 0 ? done() : fail(new AgentUsageError(`独立工作簿检查失败：${error}`)); });
    });
    const view = JSON.parse(await readFile(join(out, 'excel/view.json'), 'utf8'));
    const candidates = structuredClone(bundle.datasets) as any[];
    const evidence: ExcelEvidence = { format: 'renderweave-excel-evidence/1', sourceHash: sha256(captured.get('source.xlsx')!), definition: target.selected.ref,
      artifacts: [], sources: bundle.sources, context: plan.context ?? [], sheets: view.sheets.map((s: any) => ({ id: s.id, name: s.name })), corrections: [],
      comments: view.sheets.flatMap((s: any) => (s.comments ?? []).map((c: any) => ({ ...c, sheet: s.id }))), commentContext: plan.commentContext ?? [],
      candidates: candidates.map(d => ({ id: d.dataset.id, file: `candidates/dataset-${sha256(d.dataset.id)}.json` })) };
    let previous: RoundRecord['inputs']['previous'] = null;
    if (options.previous) {
      const previousDir = await realpath(options.previous), review = await readReview(previousDir);
      if (!review.view || review.problems.length || review.view.applied) throw new AgentUsageError('上一轮不可读取或已应用；不能自动重放');
      const oldRecord = JSON.parse(await readFile(join(previousDir, 'round.json'), 'utf8')) as RoundRecord;
      if (!oldRecord.inputs.excel) throw new AgentUsageError('上一轮不是 Excel 提取轮次');
      const oldEvidence = await readExcelEvidence(previousDir, oldRecord.inputs.excel);
      for (const correction of oldEvidence.corrections.filter(c => c.status === 'conflict')) {
        const file = oldEvidence.candidates.find(c => c.id === correction.datasetId)?.file;
        if (!file || !review.view.review.decisions.some(d => d.file === file)) throw new AgentUsageError('上一轮仍有未处理的人工修正冲突，请先在审核中明确处理');
      }
      const before = JSON.parse(await readFile(join(previousDir, 'excel/candidate.json'), 'utf8'));
      evidence.corrections = replayExcelCorrections({ previous: oldEvidence, next: evidence, before: before.datasets, candidates,
        reviewed: review.view.candidates.filter(c => c.document && !c.dropped).map(c => ({ id: c.name!, data: (c.document as any).data,
          reason: review.view!.review.decisions.find(d => d.file === c.path && d.action === 'edit')?.note })) });
      previous = { dir: previousDir, round: oldRecord.round, outcomeSha256: sha256(await readFile(join(previousDir, 'outcome.json'))), reviewSha256: review.view.saved ? sha256(await readFile(join(previousDir, 'review.json'))) : null, reviewStatus: review.view.review.status };
    }
    const checks = checkCandidates(candidates.map((d,i) => ({ path: evidence.candidates[i]!.file, kind: 'dataset' as const, document: d })), workspace, { definition: selected.ref });
    const problems = [...checks.values()].flatMap(c => c.problems).filter(p => p.level === 'severe');
    if (problems.length) throw new AgentUsageError(`完整候选集合不合格：${problems.map(p=>p.message).join('；')}`);
    for (const file of await readdir(join(out, 'excel'))) evidence.artifacts.push({ file: `excel/${file}`, sha256: sha256(await readFile(join(out,'excel',file))) });
    await writeAtomicJson(join(out, 'excel/manifest.json'), evidence, true);
    await writeFile(join(out, 'agent/sample.xlsx'), captured.get('source.xlsx')!, { flag: 'wx' });
    const fingerprint = await workspaceFingerprint(snapshot), number = (previous?.round ?? 0)+1;
    const usage: RoundUsage = { ...(result.usage ?? {}), wallMs: result.wallMs ?? 0 };
    const inputs: RoundRecord['inputs'] = { sample: { source: root, file: 'agent/sample.xlsx', sha256: evidence.sourceHash }, brief: { source: root, sha256: sha256(captured.get('brief.md')!) },
      domain: null, workspace: { source: workspaceDir, fingerprint, documents: (await readdir(snapshot)).length }, definition: selected.ref, previous,
      resourceSnapshot, ...(options.resources ? { resources: resourceSource } : {}), excel: { file: 'excel/manifest.json', sha256: sha256(await readFile(join(out, 'excel/manifest.json'))) } };
    const outcome: RoundOutcome = { format: 'renderweave-outcome/1', task: 'dataset-extraction', round: number,
      inputs: { sampleSha256: evidence.sourceHash, workspaceFingerprint: fingerprint, previous }, candidates: [], locations: [], pending: [], notes: submitted.notes, usage };
    for (const [i, candidate] of candidates.entries()) {
      const file = evidence.candidates[i]!.file;
      await writeAtomicJson(join(out,file), candidate, true);
      (outcome.candidates as any[]).push({ path: file, kind: 'dataset', name: candidate.dataset.id, sha256: sha256(await readFile(join(out,file))) });
      (outcome.locations as any[]).push({ file, where: '工作簿来源见 Excel 证据面板；请核对字段含义、映射与排除区域。' });
      const corrections = evidence.corrections.filter(c=>c.datasetId===candidate.dataset.id);
      (outcome.pending as any[]).push({ file, reason: corrections.some(c=>c.status==='conflict') ? 'conflicting' : 'inferred',
        note: ['核对这份数据集的完整业务含义；采纳表示确认全部映射及排除区域。', ...submitted.pending,
          ...corrections.map(c=>`人工修正 ${c.path}：${c.status}；${c.detail ?? c.reason}`)].join('\n') });
    }
    const runtime: RoundRecord['runtime'] = { model: start.model ?? 'unknown', smallModel: start.model ?? 'unknown', protocol: 'anthropic', endpoint: start.endpoint ?? '', maxTurns: start.maxTurns ?? 0, effort: null, keyEnv: 'OPEN_CODE_API_KEY', tools: '', mcpTools: [] };
    const record: RoundRecord = { format: 'renderweave-round/1', execution: 'renderweave-execution/1', task: 'dataset-extraction', round: number,
      startedAt: start.startedAt ?? new Date().toISOString(), endedAt: new Date().toISOString(), inputs, runtime, run: { ...usage, exitCode: 0 }, verdict: 'qualified' };
    await writeAtomicJson(join(out, 'logs/import.json'), { from: root, attempt, resultHash: sha256(await bytes('result.json')), importedAt: record.endedAt }, true);
    await execution.initialize({ task: record.task, round: number, startedAt: record.startedAt, inputs, runtime });
    await execution.finalizing();
    await writeAtomicJson(join(out, 'outcome.json'), outcome, true);
    await writeAtomicJson(join(out, 'round.json'), record, true);
    await execution.finish(record);
    return { roundDir: out, candidates: candidates.length, corrections: evidence.corrections };
  } catch (error) { await execution.fail(); throw error; }
}
