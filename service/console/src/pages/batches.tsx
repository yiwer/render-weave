/**
 * 批次（P1 票据 01）：出图模块里本标签页提交过的批次，与状态栏的"进行中的批次"。
 * 开放 API 没有列出批次的端点（本期不加端点），所以只列本标签页记下的批次，逐个读状态；全部交付结果看出图记录。
 * 已结束的批次不再变，记下来之后不再读。
 */
import { useEffect, useState } from 'react';
import { api, onUsageChanged } from '../api.js';
import { DeliverTabs } from '../components/module-tabs.js';
import { ErrorBox } from '../components/problems.js';
import { href, useLoad } from '../hooks.js';
import type { BatchView } from '../types.js';
import { onRemembered, recentBatches } from './deliver.js';

const finished = new Set<string>();

/** 本标签页提交过、还在进行的批次 ID：记下新批次、用量可能变了（取消或结束批次）时与每 10 秒读一次。 */
export function useRunningBatches(): readonly string[] {
  const [running, setRunning] = useState<readonly string[]>([]);
  const [round, setRound] = useState(0);
  useEffect(() => {
    const again = () => setRound((value) => value + 1);
    const stops = [onRemembered(again), onUsageChanged(again)];
    return () => { for (const stop of stops) stop(); };
  }, []);
  useEffect(() => {
    let live = true;
    const check = async () => {
      const ids = recentBatches().map((entry) => entry.id).filter((id) => !finished.has(id));
      // 读不到的（别的账号在这个标签页提交的、网络中断）这一轮不算进行中，下一轮再读。
      const views = await Promise.all(ids.map((id) => api.batch(id).catch(() => undefined)));
      for (const view of views) if (view?.status === 'finished') finished.add(view.id);
      if (live) setRunning(views.flatMap((view) => (view?.status === 'running' ? [view.id] : [])));
    };
    void check();
    const timer = window.setInterval(() => void check(), 10_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [round]);
  return running;
}

const stateOf = (batch: BatchView) => batch.status === 'running'
  ? (batch.cancelRequested ? ['正在取消', 'warn'] : ['进行中', 'accent'])
  : batch.cancelRequested ? ['已取消', 'warn'] : batch.summary.failed ? ['部分失败', 'warn'] : ['已完成', 'ok'];

export function BatchList() {
  const recent = recentBatches();
  const loaded = useLoad(() => Promise.all(recent.map((entry) => api.batch(entry.id).catch(() => undefined))), recent.map((entry) => entry.id).join(','));
  const anyRunning = loaded.data?.some((view) => view?.status === 'running') ?? false;
  const { reload } = loaded;
  useEffect(() => {
    if (!anyRunning) return undefined;
    const timer = window.setInterval(reload, 3000);
    return () => window.clearInterval(timer);
  }, [anyRunning, reload]);
  return (
    <section className="page">
      <DeliverTabs active="batches" />
      <div className="title-row">
        <div>
          <h1>批次</h1>
          <p className="lede">本标签页提交过的出图任务。全部已交付的图，包括别的成员与 API 密钥出的，在出图记录里查。</p>
        </div>
      </div>
      <ErrorBox problems={loaded.problems} title="读不到批次" />
      {recent.length === 0
        ? <p className="muted">这个标签页还没有提交过出图任务。到<a href={href(['datasets'])}>数据集</a>选好数据，点"出图…"。</p>
        : (
          <div className="card">
            <table className="table">
              <thead><tr><th>出图任务</th><th>模板</th><th>提交时间</th><th>状态</th><th>已交付</th></tr></thead>
              <tbody>
                {recent.map((entry, index) => {
                  const view = loaded.data?.[index];
                  const [text, tone] = view ? stateOf(view) : [loaded.loading ? '正在读取…' : '读不到', ''];
                  return (
                    <tr key={entry.id} data-testid="batch-row" data-id={entry.id}>
                      <td><a href={href(['batches', entry.id])}>{entry.title}</a> <code className="muted">{entry.id.slice(0, 8)}</code></td>
                      <td>{entry.template}</td>
                      <td className="muted">{new Date(entry.at).toLocaleString('zh-CN')}</td>
                      <td><span className={`chip ${tone}`}>{text}</span></td>
                      <td>{view ? `${view.summary.delivered.toLocaleString('zh-CN')} / ${view.progress.total.toLocaleString('zh-CN')}` : ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
    </section>
  );
}
