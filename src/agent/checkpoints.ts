/** 宿主固定检查输入并提交检查点。暂存目录不是检查点；唯一发布点是 checkpoint.json。 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { WorkingDirectory } from '../mcp/files.js';
import { ProblemCodes, severe, type Problem } from '../problems.js';
import { loadWorkspace } from '../workspace.js';
import { withLocalAccess } from '../local-access.js';
import { canonical } from './diff.js';
import { flattenElements } from './locations.js';
import { isRecord } from '../util.js';
import { readExecution, writeAtomicJson } from './execution.js';
import { checkAgentOutcome, type OutcomeCheck, type OutcomeTarget } from './outcome.js';
import { AgentUsageError, exists, sha256 } from './round-files.js';
import { readResourceSnapshot } from './content-identity.js';

export type CheckpointSignal = { readonly status: 'saved'; readonly id: string; readonly contentIdentity: string }
  | { readonly status: 'notSaved'; readonly reason: string };
export interface CheckpointCheck { readonly check: OutcomeCheck; readonly checkpoint: CheckpointSignal }
export interface CheckpointRecord {
  readonly format: 'renderweave-checkpoint/1'; readonly source: 'hostRecovery'; readonly id: string; readonly savedAt: string;
  readonly startSha256: string; readonly files: Readonly<Record<string, string>>; readonly check: OutcomeCheck;
}
export interface CheckpointView extends CheckpointRecord { readonly contentIdentity: string }
const DEPENDENCY_ERRORS = new Set<string>([ProblemCodes.templateNotFound, ProblemCodes.staticSchemaNotFound,
  ProblemCodes.compiledSchemaMissing, ProblemCodes.definitionRefNotFound, ProblemCodes.datasetNotFound,
  ProblemCodes.resourceUnreadable, ProblemCodes.resourceNotFound, ProblemCodes.datasetResourceNotFound]);

/** 短锁只保护恢复拥有权的核对/替换；不跨执行器调用持有。明确结束者可重试，未知/存活者不可抢占。 */
export async function claimCheckpointRecovery(source: string, destination: string, checkpointId: string) {
  const path = join(source, 'checkpoint-recovery.json'), owner = { id: randomUUID(), destination };
  await withLocalAccess([source], async () => {
    const original = await readExecution(source), checkpoint = await readCheckpoint(source);
    if (original.problems.length || !['interrupted', 'stopped'].includes(original.execution?.status ?? '') || checkpoint.problems.length || checkpoint.checkpoint?.id !== checkpointId)
      throw new AgentUsageError('原轮次仍可写、身份不明或检查点已变化，不能取得恢复拥有权');
    if (await exists(path)) {
      try {
        const prior = JSON.parse(await readFile(path, 'utf8'));
        const state = await readExecution(prior.destination);
        if (state.problems.length || !state.execution || (!state.execution.committed && !['interrupted', 'stopped'].includes(state.execution.status))) throw new Error();
      } catch { throw new AgentUsageError(`检查点已有恢复拥有者；请检查 checkpoint-recovery.json 指向的新轮次，不可并发接管：${source}`); }
    }
    await writeAtomicJson(path, owner);
  });
  return async () => {
    await withLocalAccess([source], async () => {
      const current = JSON.parse(await readFile(path, 'utf8'));
      if (current.id === owner.id) await rm(path);
    });
  };
}

/** 只允许宿主提供固定路径和判据，MCP 请求不能携带它们。 */
export function checkpointChecker(options: { roundDir: string; agentDir: string; snapshotDir: string; resourcesDir: string; target: OutcomeTarget }) {
  let pending: Promise<unknown> = Promise.resolve();
  const check = () => {
    const result = pending.then(() => captureAndCheck(options));
    pending = result.catch(() => undefined);
    return result;
  };
  return { check, idle: async () => { await pending; } };
}

async function captureAndCheck(options: Parameters<typeof checkpointChecker>[0]): Promise<CheckpointCheck> {
  const { roundDir, agentDir, snapshotDir, resourcesDir, target: { task, ...context } } = options;
  const id = randomUUID(), stage = join(roundDir, 'checkpoints', `.pending-${id}`);
  await mkdir(join(stage, 'agent'), { recursive: true });
  await mkdir(join(stage, 'snapshot'), { recursive: true });
  const files: Record<string, string> = {}, captured = new Map<string, Uint8Array>();
  let captureProblem: string | undefined;
  const save = async (path: string, bytes: Uint8Array) => {
    await mkdir(dirname(join(stage, path)), { recursive: true });
    await writeFile(join(stage, path), bytes, { flag: 'wx' });
    files[path] = sha256(bytes);
  };
  try {
    const working = await WorkingDirectory.open(agentDir);
    try {
      const outcome = await working.readBytes('outcome.json');
      captured.set('outcome.json', outcome);
      await save('agent/outcome.json', outcome);
      const submission = JSON.parse(Buffer.from(outcome).toString('utf8'));
      if (Array.isArray(submission?.candidates)) for (const path of submission.candidates) {
        const actual = relative(working.root, await working.resolve(path)).split(sep).join('/');
        if (!actual.startsWith('candidates/') || !actual.endsWith('.json')) continue;
        const bytes = await working.readBytes(path);
        captured.set(path, bytes);
        await save(`agent/${actual}`, bytes);
      }
    } catch (error) { captureProblem = `候选集合无法完整固定：${String(error)}`; }
    // 一轮采集后再逐字核对，读取期间的写入不得形成一个看似完整的新旧混合集合。
    for (const [path, bytes] of captured) {
      try { if (sha256(await working.readBytes(path)) !== sha256(bytes)) captureProblem = `固定期间候选发生变化：${path}`; }
      catch { captureProblem = `固定期间候选无法读取：${path}`; }
    }
    for (const file of (await readdir(snapshotDir)).filter(name => name.endsWith('.json')).sort()) await save(`snapshot/${file}`, await readFile(join(snapshotDir, file)));
    await save('basis.json', Buffer.from(JSON.stringify({ task, ...context })));
    let checkedContext = context;
    if (context.referenceImage) {
      const bytes = await readFile(context.referenceImage.path);
      await save('reference-image', bytes);
      if (sha256(bytes) !== context.referenceImage.sha256) captureProblem = '固定参考图与核准依据不符';
      checkedContext = { ...context, referenceImage: { ...context.referenceImage, path: join(stage, 'reference-image') } };
    }
    const workspace = await loadWorkspace({ dir: join(stage, 'snapshot'), resourcesDir });
    const check = await checkAgentOutcome({ task, agentDir: join(stage, 'agent'), workspace, context: checkedContext });
    // 语义受阻仍可保存，但解析失败不能掩盖缺少被调模板；按实际集合独立核对调用闭包。
    const templates = new Map(workspace.templates.map(entry => [entry.name, entry.document]));
    for (const [path, bytes] of captured) if (path !== 'outcome.json') {
      try { const value: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
        if (isRecord(value) && value.dslVersion === 'renderweave-template/1' && typeof value.name === 'string') templates.set(value.name, value);
      } catch { /* JSON 半写已经由结构检查报告。 */ }
    }
    const visited = new Set<string>(), missingCalls = new Set<string>();
    const visit = (name: string) => {
      if (visited.has(name)) return;
      visited.add(name);
      const document = templates.get(name);
      if (!document) { missingCalls.add(name); return; }
      for (const { element } of flattenElements(document)) if ((element.type === 'call' || element.type === 'loop') && typeof element.template === 'string') visit(element.template);
    };
    for (const candidate of check.candidates) if (candidate.kind === 'template' && candidate.name) visit(candidate.name);
    const missing = [...check.problems, ...check.candidates.flatMap(candidate => candidate.problems), ...check.assessment.render.problems]
      .filter(problem => problem.level === 'severe' && DEPENDENCY_ERRORS.has(problem.code));
    const reason = captureProblem ?? (!check.submission || check.assessment.structure !== 'valid' ? '候选清单或文件不完整，不能发布完整检查点'
      : missingCalls.size ? `缺少必要被调模板依赖：${[...missingCalls].join('、')}`
      : missing.length ? `缺少或无法读取必要依赖：${missing.map(problem => problem.message).join('；')}` : undefined);
    if (captureProblem) {
      const { submission: _submission, ...incomplete } = check;
      return { check: { ...incomplete, verdict: 'unqualified', assessment: { ...check.assessment, structure: 'invalid' },
        problems: check.assessment.structure === 'invalid' ? check.problems
          : [...check.problems, severe(ProblemCodes.outcomeInvalid, { kind: 'input', source: 'outcome.json' }, captureProblem)] },
        checkpoint: { status: 'notSaved', reason: captureProblem } };
    }
    if (reason || !check.contentIdentity) return { check, checkpoint: { status: 'notSaved', reason: reason ?? '检查未形成完整内容身份' } };
    const record: CheckpointRecord = { format: 'renderweave-checkpoint/1', source: 'hostRecovery', id, savedAt: new Date().toISOString(),
      startSha256: sha256(await readFile(join(roundDir, 'round-start.json'))), files, check };
    await writeAtomicJson(join(stage, 'record.json'), record, true);
    await rename(stage, join(roundDir, 'checkpoints', id));
    // 这个原子指针是唯一提交点；强退留下的目录和临时指针都不能成为最后完整候选。
    await writeAtomicJson(join(roundDir, 'checkpoint.json'), { format: 'renderweave-checkpoint-ref/1', id,
      sha256: sha256(await readFile(join(roundDir, 'checkpoints', id, 'record.json'))) });
    return { check, checkpoint: { status: 'saved', id, contentIdentity: check.contentIdentity.id } };
  } finally { await rm(stage, { recursive: true, force: true }); }
}

/** 只读已提交集合；每次核对清单、候选、依据与内容身份，不信任目录名或残留文件。 */
export async function readCheckpoint(roundDir: string): Promise<{ checkpoint?: CheckpointView; problems: Problem[] }> {
  if (!(await exists(join(roundDir, 'checkpoint.json')))) return { problems: [] };
  try {
    const ref = JSON.parse(await readFile(join(roundDir, 'checkpoint.json'), 'utf8'));
    if (ref.format !== 'renderweave-checkpoint-ref/1' || !/^[a-f0-9-]{36}$/.test(ref.id)) throw new Error('检查点引用不合法');
    const root = join(roundDir, 'checkpoints', ref.id), safe = await WorkingDirectory.open(root);
    const bytes = await safe.readBytes('record.json');
    if (sha256(bytes) !== ref.sha256) throw new Error('检查点记录哈希不符');
    const record = JSON.parse(Buffer.from(bytes).toString('utf8')) as CheckpointRecord;
    if (record.format !== 'renderweave-checkpoint/1' || record.id !== ref.id || record.source !== 'hostRecovery'
      || !record.check.submission || !record.check.contentIdentity || !record.files) throw new Error('检查点记录不完整');
    if (sha256(await readFile(join(roundDir, 'round-start.json'))) !== record.startSha256) throw new Error('检查点所基于的轮次输入已变化');
    for (const [path, hash] of Object.entries(record.files)) if (sha256(await safe.readBytes(path)) !== hash) throw new Error(`检查点内容已变化：${path}`);
    const { id: contentId, ...identity } = record.check.contentIdentity;
    if (sha256(canonical(identity)) !== contentId) throw new Error('检查内容身份不符');
    for (const candidate of record.check.candidates) if (record.files[`agent/${candidate.path}`] !== candidate.sha256) throw new Error('检查候选与保存字节不符');
    const submission = JSON.parse(Buffer.from(await safe.readBytes('agent/outcome.json')).toString('utf8'));
    if (canonical(submission) !== canonical(record.check.submission) || canonical(identity.candidates) !== canonical({
      files: record.check.candidates.map(({ path, sha256 }) => ({ path, sha256 })), submission: sha256(canonical(submission)) })) throw new Error('检查清单与内容身份不符');
    const start = JSON.parse(await readFile(join(roundDir, 'round-start.json'), 'utf8'));
    if (start.inputs.resourceSnapshot) {
      await readResourceSnapshot(roundDir, start.inputs.resourceSnapshot);
      for (const resource of identity.resources) if (resource.sha256 !== null) {
        if (!/^[A-Za-z0-9_-]+$/.test(resource.id)) throw new Error('检查资源标识不合法');
        const bytes = await readFile(join(roundDir, start.inputs.resourceSnapshot.directory, `${resource.id}.bin`));
        if (sha256(bytes) !== resource.sha256 || bytes.length !== resource.byteLength) throw new Error(`检查资源已变化：${resource.id}`);
      }
    }
    return { checkpoint: { ...record, contentIdentity: contentId }, problems: [] };
  } catch (error) { return { problems: [severe(ProblemCodes.roundInvalid, { kind: 'input', source: join(roundDir, 'checkpoint.json') }, `检查点无法核对：${String(error)}`)] }; }
}
