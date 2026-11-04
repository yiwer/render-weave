/** 独立于渲染 worker 的 Agent 调度器。租约过期不自动重新计费运行，保留失败并由用户重试。 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ServiceBackend, TenantStorage, RoundUsageEntry } from './backend.js';
import { advanceJob, AgentJobConflict, type AgentJob, type AgentArtifact } from './agent-jobs.js';
import { agentScratch, artifactBytes, captureAgentFiles, contentHash } from './agent-files.js';
import { importExcelRound, runExcelExtraction, readReview } from './engine.js';

export type WorkbookExtractor = (input: { job: AgentJob; storage: TenantStorage; root: string; signal: AbortSignal; progress: (message: string) => void }) => Promise<{ round: string; usage?: RoundUsageEntry }>;
export const extractWorkbook: WorkbookExtractor = async ({ job, storage, root, signal, progress }) => {
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  for (const [index, file] of job.workspace.entries()) {
    const bytes = await artifactBytes(storage, { ...file, file: String(index) });
    await writeFile(join(workspace, `${index}.json`), bytes);
  }
  const workbook = join(root, 'source.xlsx'), brief = join(root, 'brief.md'), out = join(root, 'extraction');
  await writeFile(workbook, await artifactBytes(storage, job.source)); await writeFile(brief, job.brief);
  const result = await runExcelExtraction({ workspace, definition: `${job.staticSchema.name}@${job.staticSchema.version}`, workbook, brief, out,
    signal, onProgress: progress, executor: 'tool-runner', python: process.env['RW_AGENT_PYTHON'] ?? (process.platform === 'win32' ? 'python' : 'python3'),
    ...(process.env['RW_AGENT_MODEL'] ? { model: process.env['RW_AGENT_MODEL'] } : {}),
    ...(process.env['RW_AGENT_ENDPOINT'] ? { endpoint: process.env['RW_AGENT_ENDPOINT'] } : {}) });
  if (!result.passed) throw new Error('提取没有通过独立检查；请调整说明后重试');
  progress('转换已完成，正在固定审核材料并再次核对来源');
  const round = join(root, 'round');
  await importExcelRound({ from: out, workspace, out: round, python: process.env['RW_AGENT_PYTHON'] ?? (process.platform === 'win32' ? 'python' : 'python3') });
  const view = await readReview(round);
  if (!view.view || view.problems.length) throw new Error('审核材料不完整，不能进入确认保存');
  const bytes = await readFile(join(round, 'round.json'));
  const used = view.view.round.usage;
  const tokens = Object.fromEntries(['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens'].map(k => [k, used[k as keyof typeof used] ?? 0])) as RoundUsageEntry['tokens'];
  return { round, usage: { sha256: contentHash(bytes), task: 'dataset-extraction', round: 1, tokens } };
};

export function startAgentWorker(options: { backend: ServiceBackend; extract?: WorkbookExtractor; pollMs?: number; onError?: (error: unknown) => void }) {
  let stopped = false, active: AbortController | undefined;
  const running = (async () => {
    while (!stopped) {
      try {
        for (const tenant of await options.backend.platform.listTenants()) {
          if (stopped) break;
          const storage = options.backend.tenant(tenant.id).storage, store = storage.agentJobs;
          const jobs = await store.list();
          for (const expired of jobs.filter(j => j.status === 'running' && j.lease && Date.parse(j.lease.until) < Date.now())) {
            await store.save(advanceJob(expired, { status: 'failed', message: '处理进程已中断。原件已保留，请重新发起提取。' }, '执行租约已过期'), expired.revision).catch(e => { if (!(e instanceof AgentJobConflict)) throw e; });
          }
          const queued = jobs.find(j => j.status === 'queued'); if (!queued) continue;
          const token = randomUUID(), claimed = advanceJob(queued, { status: 'running', lease: { token, until: new Date(Date.now() + 15 * 60_000).toISOString() } }, '正在读取原件');
          try { await store.save(claimed, queued.revision); } catch (e) { if (e instanceof AgentJobConflict) continue; throw e; }
          active = new AbortController(); const signal = active.signal;
          let progress: Promise<void> = Promise.resolve(), lastMessage = '';
          let diagnostics: AgentArtifact[] | undefined, failedUsage: RoundUsageEntry | undefined;
          const update = async (message: string) => {
            const job = await store.get(queued.id);
            if (job?.status !== 'running' || job.lease?.token !== token) { active?.abort(); return; }
            await store.save(advanceJob(job, {}, message), job.revision);
          };
          const poll = setInterval(() => { void store.get(queued.id).then(job => { if (job?.status !== 'running' || job.lease?.token !== token) active?.abort(); }, () => active?.abort()); }, 500);
          try {
            await agentScratch(async root => {
              try {
                const result = await (options.extract ?? extractWorkbook)({ job: claimed, storage, root, signal, progress: message => {
                if (message === lastMessage) return; lastMessage = message;
                progress = progress.then(() => update(message)).catch(() => { active?.abort(); });
              } });
              await progress;
              const checked = await readReview(result.round);
              if (!checked.view?.excel || checked.problems.length || checked.view.excel.sourceHash !== claimed.source.sha256
                || checked.view.excel.definition.name !== claimed.staticSchema.name || checked.view.excel.definition.version !== claimed.staticSchema.version) throw new Error('提取结果与任务的原件或目标定义身份不一致');
              const artifacts = await captureAgentFiles(storage, result.round);
              diagnostics = await captureAgentFiles(storage, root);
              const current = await store.get(queued.id);
              if (!current || current.status !== 'running' || current.lease?.token !== token || signal.aborted) throw new Error('任务已取消');
              await store.save(advanceJob(current, { status: 'needsReview', artifacts, diagnostics, ...(result.usage ? { usage: result.usage } : {}) }, '独立检查完成，请核对数据、来源和批注'), current.revision, result.usage ? { usage: result.usage } : {});
              } catch (error) {
                diagnostics = await captureAgentFiles(storage, root).catch(() => undefined);
                try {
                  const bytes = await readFile(join(root, 'extraction/result.json')), result = JSON.parse(bytes.toString('utf8'));
                  const tokens = Object.fromEntries(['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens'].map(k => [k, Math.max(0, Number(result.usage?.[k] ?? 0))])) as RoundUsageEntry['tokens'];
                  failedUsage = { sha256: contentHash(bytes), task: 'dataset-extraction', round: 1, tokens };
                } catch { /* 未启动模型的失败没有用量记录。 */ }
                throw error;
              }
            });
          } catch (error) {
            await progress.catch(() => undefined);
            const current = await store.get(queued.id);
            if (current && ['running', 'cancelled'].includes(current.status) && current.lease?.token === token) {
              // 诊断不把 SDK 错误、命令行或凭据返回给浏览器。
              const cancelled = current.status === 'cancelled' || signal.aborted;
              await store.save(advanceJob(current, { status: cancelled ? 'cancelled' : 'failed', message: cancelled ? '任务已停止' : '提取失败，原件已保留。请检查服务配置或调整说明后重试。',
                ...(diagnostics ? { diagnostics } : {}), ...(failedUsage ? { usage: failedUsage } : {}) }, '处理已停止'), current.revision, failedUsage ? { usage: failedUsage } : {});
            }
            options.onError?.(error);
          } finally { clearInterval(poll); active = undefined; }
        }
      } catch (error) { options.onError?.(error); }
      if (!stopped) await new Promise(resolve => setTimeout(resolve, options.pollMs ?? 1000));
    }
  })();
  return { async stop() { stopped = true; active?.abort(); await running; } };
}
