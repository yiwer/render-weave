/**
 * 平台管理（P1 票据 12，M247、M261、M274，原型画板 20）：只给平台管理员——服务健康、租户与套餐、成员账号、代建令牌。
 * - 全部用 /v1/platform/* 端点，一页的汇总来自 GET /v1/platform/overview；
 * - 初始密码与代建令牌只在创建的回答里出现一次：只放在这一块的状态里，关掉、换页就没了，不写进存储；
 * - Agent token 只显示用量，按额度拦截是 P4（M242）；对客户租户的每次操作都记进该租户的审计（M261）。
 */
import { useState } from 'react';
import { api } from '../api.js';
import { OneTimeSecret } from '../components/one-time-secret.js';
import { ErrorBox } from '../components/problems.js';
import { href, problemsOf, useLoad } from '../hooks.js';
import type { AuthoringTokenInfo, Member, PlatformOverview, PlatformTenant, Problem } from '../types.js';

const number = (value: number) => value.toLocaleString('zh-CN');
const time = (at: string) => new Date(at).toLocaleString('zh-CN');
/** 构建标识只显示开头，悬停看全文。 */
const shortBuild = (build: string) => build.replace(/^sha256:/, '').slice(0, 12);
const NEAR_LIMIT = 0.8;

/** 租户的状态：没设套餐不能正式交付（M274）；已用加预占到 80% 算接近上限。 */
function tenantStatus(tenant: PlatformTenant): { readonly tone: 'ok' | 'warn' | 'bad'; readonly label: string } {
  const { limit, used, reserved } = tenant.images;
  if (limit === 0) return { tone: 'warn', label: '未设套餐' };
  if (used + reserved >= limit) return { tone: 'bad', label: '额度用完' };
  return (used + reserved) / limit >= NEAR_LIMIT ? { tone: 'warn', label: '接近上限' } : { tone: 'ok', label: '正常' };
}

export function PlatformPage(props: { readonly tab?: string }) {
  const tokens = props.tab === 'tokens';
  return (
    <section className="page">
      <nav className="module-tabs" aria-label="平台">
        <a href={href(['platform'])} aria-current={tokens ? undefined : 'page'}>租户</a>
        <a href={href(['platform', 'tokens'])} aria-current={tokens ? 'page' : undefined}>代建令牌</a>
      </nav>
      {tokens ? <Tokens /> : <Tenants />}
      <p className="table-note">你对客户租户的每次操作都记进该租户的审计，客户管理员看得到。</p>
    </section>
  );
}

/** 服务健康一行：接口就绪、worker 报到数与构建、队列积压。 */
function Health(props: { readonly service: PlatformOverview['service'] }) {
  const { service } = props, workers = service.workers.reduce((sum, entry) => sum + entry.workers, 0);
  const failing = Object.entries(service.checks).filter(([, state]) => state !== 'ok').map(([name]) => name);
  const queue = service.queue;
  const waiting = queue ? queue.queued.preview + queue.queued.batchItem + queue.queued.replay : undefined;
  const running = queue ? queue.running.preview + queue.running.batchItem + queue.running.replay : undefined;
  return (
    <div className="health" data-testid="service-health">
      <span className={`chip ${service.ready ? 'ok' : 'bad'}`}>接口 {service.ready ? '就绪' : `未就绪${failing.length ? `（${failing.join('、')}）` : ''}`}</span>
      <span className={`chip ${workers > 0 ? 'ok' : 'bad'}`} data-testid="health-workers">渲染 worker {workers}</span>
      {service.workers.map((entry) => <span key={entry.build} className="small muted mono" title={entry.build}>{shortBuild(entry.build)} × {entry.workers}</span>)}
      {queue && <span className="chip" data-testid="health-queue">排队 {number(waiting!)} · 渲染中 {number(running!)}{queue.oldestQueuedMs > 0 ? ` · 最久等了 ${Math.ceil(queue.oldestQueuedMs / 1000)} 秒` : ''}</span>}
    </div>
  );
}

function Tenants() {
  const loaded = useLoad(() => api.platformOverview(), 'platform-overview');
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string>();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<readonly Problem[]>();
  const overview = loaded.data;
  const create = async () => {
    setBusy(true);
    setProblems(undefined);
    try {
      const tenant = await api.createTenant(name.trim());
      setName('');
      setCreating(false);
      setOpen(tenant.id);
      loaded.reload();
    } catch (error) { setProblems(problemsOf(error)); }
    finally { setBusy(false); }
  };
  return (
    <>
      <div className="title-row">
        <h1>租户</h1>
        <button type="button" className="primary" aria-expanded={creating} onClick={() => { setCreating(!creating); setProblems(undefined); }}>开通租户</button>
      </div>
      {overview && <Health service={overview.service} />}
      {creating && (
        <form className="inline-form" aria-label="开通租户" onSubmit={(event) => { event.preventDefault(); if (name.trim()) void create(); }}>
          <div className="field">
            <label htmlFor="new-tenant-name">租户名称</label>
            <input id="new-tenant-name" type="text" autoFocus maxLength={100} value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <button type="submit" className="primary" disabled={!name.trim() || busy}>{busy ? '正在开通…' : '开通'}</button>
          <span className="small muted">开通后在下面设套餐、建成员账号；没设套餐的租户不能正式交付。</span>
        </form>
      )}
      <ErrorBox problems={problems} title="没有开通" />
      <ErrorBox problems={loaded.problems} title="读不到租户" />
      {loaded.loading && !overview && <p className="muted">正在读取…</p>}
      {overview && (
        <div className="card">
          <table className="table tenant-table">
            <thead><tr><th>租户</th><th>每月出图</th><th>本月出图</th><th>本月 Agent token</th><th>成员</th><th>状态</th></tr></thead>
            <tbody>
              {overview.tenants.length === 0 && <tr><td colSpan={6} className="muted">还没有租户。</td></tr>}
              {overview.tenants.map((tenant) => {
                const status = tenantStatus(tenant), expanded = open === tenant.id;
                return [
                  <tr key={tenant.id} data-testid="tenant-row" data-name={tenant.name} className={expanded ? 'selected' : undefined}>
                    <td>
                      <button type="button" className="link-button" aria-expanded={expanded} aria-controls={expanded ? `tenant-${tenant.id}` : undefined}
                        onClick={() => setOpen(expanded ? undefined : tenant.id)}>{tenant.name}</button>
                    </td>
                    <td>{number(tenant.plan.monthlyImages)} 张</td>
                    <td data-testid="tenant-images">{number(tenant.images.used + tenant.images.reserved)} / {number(tenant.images.limit)}</td>
                    <td data-testid="tenant-tokens">{number(Object.values(tenant.tokens).reduce((sum, value) => sum + value, 0))}</td>
                    <td data-testid="tenant-members">{tenant.members}</td>
                    <td><span className={`chip ${status.tone}`} data-testid="tenant-status">{status.label}</span></td>
                  </tr>,
                  expanded && (
                    <tr key={`${tenant.id}-detail`} className="selected">
                      <td colSpan={6} id={`tenant-${tenant.id}`} data-testid="tenant-detail">
                        <PlanForm key={JSON.stringify(tenant.plan)} tenant={tenant} onSaved={loaded.reload} />
                        <NewMember tenantId={tenant.id} onCreated={loaded.reload} />
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/** 套餐（M274）：每月出图张数、单张最大像素与并发。像素按百万（MP）填，1 亿像素是引擎上限。 */
function PlanForm(props: { readonly tenant: PlatformTenant; readonly onSaved: () => void }) {
  const { plan, id } = props.tenant;
  const [monthlyImages, setMonthlyImages] = useState(String(plan.monthlyImages));
  const [megapixels, setMegapixels] = useState(String(plan.maxPixels / 1_000_000));
  const [concurrency, setConcurrency] = useState(String(plan.concurrency));
  const [problems, setProblems] = useState<readonly Problem[]>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setProblems(undefined);
    setNotice(undefined);
    try {
      await api.setPlan(id, { monthlyImages: Number(monthlyImages), maxPixels: Math.round(Number(megapixels) * 1_000_000), concurrency: Number(concurrency) });
      setNotice('已保存');
      props.onSaved();
    } catch (error) { setProblems(problemsOf(error)); }
    finally { setBusy(false); }
  };
  return (
    <form className="inline-form" aria-label="套餐" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <div className="field">
        <label htmlFor={`plan-images-${id}`}>每月出图（张）</label>
        <input id={`plan-images-${id}`} type="number" min={0} step={1} required value={monthlyImages} onChange={(event) => setMonthlyImages(event.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={`plan-pixels-${id}`}>单张最大像素（MP）</label>
        <input id={`plan-pixels-${id}`} type="number" min={0.000001} max={100} step="any" required value={megapixels} onChange={(event) => setMegapixels(event.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={`plan-concurrency-${id}`}>并发</label>
        <input id={`plan-concurrency-${id}`} type="number" min={1} max={64} step={1} required value={concurrency} onChange={(event) => setConcurrency(event.target.value)} />
      </div>
      <button type="submit" disabled={busy}>{busy ? '正在保存…' : '保存套餐'}</button>
      {notice && <span className="small muted" role="status">{notice}</span>}
      <ErrorBox problems={problems} title="没有保存" />
    </form>
  );
}

function NewMember(props: { readonly tenantId: string; readonly onCreated: () => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Member['role']>('admin');
  const [created, setCreated] = useState<{ readonly email: string; readonly password: string }>();
  const [problems, setProblems] = useState<readonly Problem[]>();
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    setProblems(undefined);
    try {
      const reply = await api.createTenantMember(props.tenantId, { email: email.trim(), role });
      setCreated({ email: reply.member.email, password: reply.initialPassword });
      setEmail('');
      props.onCreated();
    } catch (error) { setProblems(problemsOf(error)); }
    finally { setBusy(false); }
  };
  const id = props.tenantId;
  return (
    <>
      <form className="inline-form" aria-label="建成员账号" onSubmit={(event) => { event.preventDefault(); if (email.trim()) void create(); }}>
        <div className="field grow">
          <label htmlFor={`member-email-${id}`}>成员邮箱</label>
          <input id={`member-email-${id}`} type="email" placeholder="name@company.com" value={email} onChange={(event) => setEmail(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={`member-role-${id}`}>角色</label>
          <select id={`member-role-${id}`} value={role} onChange={(event) => setRole(event.target.value as Member['role'])}>
            <option value="admin">客户管理员</option>
            <option value="operator">客户操作员</option>
          </select>
        </div>
        <button type="submit" className="primary" disabled={!email.trim() || busy}>{busy ? '正在创建…' : '创建账号'}</button>
      </form>
      <ErrorBox problems={problems} title="没有创建" />
      {created && <OneTimeSecret title={`${created.email} 的初始密码`} secret={created.password} note="请经安全渠道转交。" onClose={() => setCreated(undefined)} />}
    </>
  );
}

const tokenState = (token: AuthoringTokenInfo): { readonly tone: 'ok' | 'warn'; readonly label: string } =>
  token.revokedAt ? { tone: 'warn', label: '已吊销' } : Date.parse(token.expiresAt) <= Date.now() ? { tone: 'warn', label: '已过期' } : { tone: 'ok', label: '有效' };

function Tokens() {
  const tokens = useLoad(() => api.authoringTokens(), 'authoring-tokens');
  const tenants = useLoad(() => api.platformTenants(), 'platform-tenants');
  const [label, setLabel] = useState('');
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [days, setDays] = useState('30');
  const [created, setCreated] = useState<{ readonly label: string; readonly token: string }>();
  const [confirming, setConfirming] = useState<string>();
  const [problems, setProblems] = useState<readonly Problem[]>();
  const [busy, setBusy] = useState(false);
  const names = new Map(tenants.data?.tenants.map((tenant) => [tenant.id, tenant.name]));
  const issue = async () => {
    setBusy(true);
    setProblems(undefined);
    try {
      const reply = await api.createAuthoringToken({ label: label.trim(), tenantIds: [...chosen], expiresInDays: Number(days) });
      setCreated({ label: reply.authoringToken.label, token: reply.token });
      setLabel('');
      setChosen([]);
      tokens.reload();
    } catch (error) { setProblems(problemsOf(error)); }
    finally { setBusy(false); }
  };
  const revoke = async (id: string) => {
    setProblems(undefined);
    setConfirming(undefined);
    try { await api.revokeAuthoringToken(id); tokens.reload(); } catch (error) { setProblems(problemsOf(error)); }
  };
  return (
    <>
      <div className="title-row"><h1>代建令牌</h1></div>
      <form className="inline-form" aria-label="签发代建令牌" onSubmit={(event) => { event.preventDefault(); if (label.trim() && chosen.length) void issue(); }}>
        <div className="field grow">
          <label htmlFor="token-label">标签</label>
          <input id="token-label" type="text" maxLength={100} placeholder="谁在用、做哪一单" value={label} onChange={(event) => setLabel(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="token-days">有效天数</label>
          <input id="token-days" type="number" min={1} max={365} step={1} required value={days} onChange={(event) => setDays(event.target.value)} />
        </div>
        <button type="submit" className="primary" disabled={!label.trim() || !chosen.length || busy}>{busy ? '正在签发…' : '签发'}</button>
        <fieldset className="tenant-picks">
          <legend>能访问的租户</legend>
          {tenants.data?.tenants.length === 0 && <span className="small muted">还没有租户。</span>}
          {tenants.data?.tenants.map((tenant) => (
            <label key={tenant.id} className="check">
              <input type="checkbox" checked={chosen.includes(tenant.id)}
                onChange={(event) => setChosen(event.target.checked ? [...chosen, tenant.id] : chosen.filter((id) => id !== tenant.id))} />{tenant.name}
            </label>
          ))}
        </fieldset>
      </form>
      {created && <OneTimeSecret title={`「${created.label}」的代建令牌`} secret={created.token} note="代建工程师经环境变量 RENDERWEAVE_AUTHORING_TOKEN 传给命令行。" onClose={() => setCreated(undefined)} />}
      <ErrorBox problems={problems} title="没有完成" />
      <ErrorBox problems={tokens.problems} title="读不到代建令牌" />
      <ErrorBox problems={tenants.problems} title="读不到租户" />
      <div className="card">
        <table className="table">
          <thead><tr><th>标签</th><th>开头</th><th>租户</th><th>签发</th><th>过期</th><th>状态</th><th><span className="visually-hidden">操作</span></th></tr></thead>
          <tbody>
            {tokens.data?.tokens.length === 0 && <tr><td colSpan={7} className="muted">还没有代建令牌。</td></tr>}
            {tokens.data?.tokens.map((token) => {
              const state = tokenState(token);
              return (
                <tr key={token.id} data-testid="token-row" data-label={token.label}>
                  <td>{token.label}</td>
                  <td className="mono">{token.prefix}…</td>
                  <td>{token.tenantIds.map((id) => names.get(id) ?? id).join('、')}</td>
                  <td>{time(token.createdAt)}</td>
                  <td>{time(token.expiresAt)}</td>
                  <td><span className={`chip ${state.tone}`} data-testid="token-state">{state.label}</span></td>
                  <td className="row-actions">
                    {state.label === '有效' && (confirming === token.id
                      ? <><button type="button" className="small danger" onClick={() => void revoke(token.id)}>确认吊销</button><button type="button" className="small quiet" onClick={() => setConfirming(undefined)}>取消</button></>
                      : <button type="button" className="small quiet" onClick={() => setConfirming(token.id)}>吊销</button>)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
