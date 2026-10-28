/**
 * 管理（票据 14，M301）：只给客户管理员——成员与角色、API 密钥、webhook 与投递记录、审计日志（M247）。
 * - 操作员打开这一页只看到说明，不请求这些端点；服务端按权限矩阵本来就拒绝（403），这里只是不让人走到那一步；
 * - API 密钥与 webhook 的签名密钥只在创建的回答里出现一次：只放在这一块面板的状态里，关掉、换标签或离开就没了，不写进存储；
 * - 新成员与重置密码由平台管理员办理（v1.0 不做自助注册，M247）；自己的角色与状态不在这里改，免得把自己关在门外。
 */
import { useState } from 'react';
import { api } from '../api.js';
import { PagedFooter } from '../components/paged.js';
import { ErrorBox } from '../components/problems.js';
import { go, href, problemsOf, useLoad, usePaged } from '../hooks.js';
import type { ApiKeyInfo, Identity, Member, Problem, Webhook, WebhookDelivery } from '../types.js';
import { AuditLog } from './audit-log.js';

const TABS = [['members', '成员'], ['api-keys', 'API 密钥'], ['webhooks', 'webhook'], ['audit', '审计日志']] as const;
type Tab = (typeof TABS)[number][0];
const ROLE: Readonly<Record<Member['role'], string>> = { admin: '客户管理员', operator: '客户操作员' };
const time = (at: string) => new Date(at).toLocaleString('zh-CN');

export function AdminPage(props: { readonly identity: Identity; readonly tab?: string }) {
  const tab: Tab = TABS.some(([name]) => name === props.tab) ? props.tab as Tab : 'members';
  if (props.identity.role !== 'admin') {
    return (
      <section className="page">
        <div className="title-row">
          <div>
            <h1>管理</h1>
            <p className="lede">管理页面只给客户管理员：成员与角色、API 密钥、webhook 与审计日志。需要时请联系本租户的管理员。</p>
          </div>
        </div>
        <p><a href={href(['datasets'])}>回到数据集</a></p>
      </section>
    );
  }
  return (
    <section className="page">
      <div className="title-row">
        <div>
          <h1>管理</h1>
          <p className="lede">本租户的成员、给开发者的 API 密钥、批次结束时的通知，以及谁在什么时候做了什么。</p>
        </div>
      </div>
      <div className="tabs" role="tablist" aria-label="管理">
        {TABS.map(([name, label]) => (
          <button key={name} type="button" role="tab" id={`tab-${name}`} aria-selected={tab === name} aria-controls="admin-panel" className={tab === name ? 'active' : undefined}
            onClick={() => go(['admin', name])}>{label}</button>
        ))}
      </div>
      <div id="admin-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === 'members' && <Members identity={props.identity} />}
        {tab === 'api-keys' && <ApiKeys />}
        {tab === 'webhooks' && <Webhooks />}
        {tab === 'audit' && <AuditLog />}
      </div>
    </section>
  );
}

/** 只出现一次的密钥：关掉就没了。复制在 http 地址上可能不可用，那时手动选中复制。 */
function OneTimeSecret(props: { readonly title: string; readonly secret: string; readonly note: string; readonly onClose: () => void }) {
  const [copied, setCopied] = useState<string>();
  const copy = async () => {
    try { await navigator.clipboard.writeText(props.secret); setCopied('已复制'); } catch { setCopied('浏览器不让复制，请选中后手动复制'); }
  };
  return (
    <section className="secret" aria-labelledby="secret-title">
      <h3 id="secret-title">{props.title}</h3>
      <p className="small"><strong>只显示这一次</strong>：关掉或离开这一页后再也看不到。{props.note}</p>
      <code className="secret-value" data-testid="one-time-secret">{props.secret}</code>
      <div className="actions">
        <button type="button" className="small" onClick={() => void copy()}>复制</button>
        <button type="button" className="small primary" onClick={props.onClose}>我已保存，关闭</button>
        {copied && <span className="small muted" role="status">{copied}</span>}
      </div>
    </section>
  );
}

function Members(props: { readonly identity: Identity }) {
  const loaded = useLoad(() => api.members(), 'members');
  const [members, setMembers] = useState<readonly Member[]>();
  const [notice, setNotice] = useState<string>();
  const [problems, setProblems] = useState<readonly Problem[]>();
  const [confirming, setConfirming] = useState<string>();
  const list = members ?? loaded.data?.members ?? [];
  const change = async (member: Member, update: { role?: Member['role']; active?: boolean }, done: string) => {
    setNotice(undefined);
    setProblems(undefined);
    setConfirming(undefined);
    try {
      const updated = await api.updateMember(member.id, update);
      // 按最新的列表更新：连着改两位成员时，后到的回答不覆盖前一个。
      setMembers((previous) => (previous ?? loaded.data?.members ?? []).map((entry) => (entry.id === updated.id ? updated : entry)));
      setNotice(done);
    } catch (error) { setProblems(problemsOf(error)); }
  };
  return (
    <div className="card">
      <div className="card-head">
        <h2>成员与角色</h2>
        <span className="small muted">客户管理员另管成员、密钥、webhook、替换资源与审计；客户操作员管数据集、上传资源、预览与出图。新成员与重置密码请联系平台管理员。</span>
      </div>
      {notice && <p className="notice" role="status">{notice}</p>}
      <ErrorBox problems={problems} title="没有改成" />
      <ErrorBox problems={loaded.problems} title="读不到成员" />
      <table className="table">
        <thead><tr><th>邮箱</th><th>角色</th><th>状态</th><th>开通时间</th><th><span className="visually-hidden">操作</span></th></tr></thead>
        <tbody>
          {list.map((member) => {
            const self = member.id === props.identity.userId;
            return (
              <tr key={member.id} data-testid="member-row" data-id={member.id} data-email={member.email}>
                <td>{member.email}{self && <span className="muted">（你）</span>}</td>
                <td>
                  <select aria-label={`${member.email} 的角色`} value={member.role} disabled={self}
                    title={self ? '自己的角色请另一位管理员修改' : undefined}
                    onChange={(event) => { const role = event.target.value as Member['role']; void change(member, { role }, `已把 ${member.email} 改为${ROLE[role]}`); }}>
                    <option value="admin">{ROLE.admin}</option>
                    <option value="operator">{ROLE.operator}</option>
                  </select>
                </td>
                <td><span className={`chip ${member.active ? 'ok' : 'warn'}`}>{member.active ? '启用' : '已停用'}</span></td>
                <td>{time(member.createdAt)}</td>
                <td className="row-actions">
                  {self ? <span className="small muted">不能改自己</span>
                    : confirming === member.id ? (
                      <span className="confirm">
                        停用后这位成员的会话立即失效，不能再登录。
                        <button type="button" className="danger small" onClick={() => void change(member, { active: false }, `已停用 ${member.email}`)}>确认停用</button>
                        <button type="button" className="small" onClick={() => setConfirming(undefined)}>不停用</button>
                      </span>
                    ) : member.active
                      ? <button type="button" className="small quiet" onClick={() => setConfirming(member.id)}>停用</button>
                      : <button type="button" className="small quiet" onClick={() => void change(member, { active: true }, `已启用 ${member.email}`)}>启用</button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ApiKeys() {
  const loaded = useLoad(() => api.apiKeys(), 'api-keys');
  const [name, setName] = useState('');
  const [created, setCreated] = useState<{ readonly name: string; readonly key: string }>();
  const [confirming, setConfirming] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<readonly Problem[]>();
  const create = async () => {
    setBusy(true);
    setProblems(undefined);
    try {
      const reply = await api.createApiKey(name.trim());
      setCreated({ name: reply.apiKey.name, key: reply.key });
      setName('');
      loaded.reload();
    } catch (error) { setProblems(problemsOf(error)); }
    finally { setBusy(false); }
  };
  const revoke = async (key: ApiKeyInfo) => {
    setConfirming(undefined);
    setProblems(undefined);
    try { await api.revokeApiKey(key.id); loaded.reload(); } catch (error) { setProblems(problemsOf(error)); }
  };
  return (
    <div className="card">
      <div className="card-head">
        <h2>API 密钥</h2>
        <span className="small muted">给开发者调用开放 API：有操作员的全部权限，另能管理 webhook；不能管成员与密钥，也不能替换资源。不过期，可随时吊销。</span>
      </div>
      <form className="actions" onSubmit={(event) => { event.preventDefault(); if (name.trim()) void create(); }}>
        <label htmlFor="key-name" className="visually-hidden">密钥名称</label>
        <input id="key-name" type="text" maxLength={100} value={name} style={{ flex: '0 1 320px' }} placeholder="密钥名称，如：ERP 对接" onChange={(event) => setName(event.target.value)} />
        <button type="submit" className="primary" disabled={!name.trim() || busy}>{busy ? '正在创建…' : '创建密钥'}</button>
      </form>
      {created && <OneTimeSecret title={`新密钥「${created.name}」`} secret={created.key} note="请现在复制，交给开发者；忘了就吊销它，再建一个。" onClose={() => setCreated(undefined)} />}
      <ErrorBox problems={problems} title="没有完成" />
      <ErrorBox problems={loaded.problems} title="读不到 API 密钥" />
      <table className="table" style={{ marginTop: 16 }}>
        <thead><tr><th>名称</th><th>开头</th><th>创建时间</th><th>状态</th><th><span className="visually-hidden">操作</span></th></tr></thead>
        <tbody>
          {loaded.data?.apiKeys.length === 0 && <tr><td colSpan={5} className="muted">还没有 API 密钥。</td></tr>}
          {loaded.data?.apiKeys.map((key) => (
            <tr key={key.id} data-testid="api-key-row" data-id={key.id}>
              <td>{key.name}</td>
              <td className="mono">{key.prefix}…</td>
              <td>{time(key.createdAt)}</td>
              <td>{key.revokedAt ? <span className="chip warn">已吊销 · {time(key.revokedAt)}</span> : <span className="chip ok">有效</span>}</td>
              <td className="row-actions">
                {!key.revokedAt && (confirming === key.id ? (
                  <span className="confirm">
                    吊销后用它的请求立即被拒绝。
                    <button type="button" className="danger small" onClick={() => void revoke(key)}>确认吊销</button>
                    <button type="button" className="small" onClick={() => setConfirming(undefined)}>不吊销</button>
                  </span>
                ) : <button type="button" className="small quiet" onClick={() => setConfirming(key.id)}>吊销</button>)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const DELIVERY: Readonly<Record<WebhookDelivery['status'], string>> = { pending: '投递中', succeeded: '已送达', failed: '失败' };

function Webhooks() {
  const loaded = useLoad(() => api.webhooks(), 'webhooks');
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [created, setCreated] = useState<{ readonly url: string; readonly secret: string }>();
  const [open, setOpen] = useState<Webhook>();
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<readonly Problem[]>();
  const register = async () => {
    setBusy(true);
    setProblems(undefined);
    try {
      const reply = await api.createWebhook({ url: url.trim(), ...(description.trim() ? { description: description.trim() } : {}) });
      setCreated({ url: reply.webhook.url, secret: reply.secret });
      setUrl('');
      setDescription('');
      loaded.reload();
    } catch (error) { setProblems(problemsOf(error)); }
    finally { setBusy(false); }
  };
  const toggle = async (hook: Webhook) => {
    setProblems(undefined);
    try { await api.updateWebhook(hook.id, { active: !hook.active }); loaded.reload(); } catch (error) { setProblems(problemsOf(error)); }
  };
  return (
    <div className="card">
      <div className="card-head">
        <h2>webhook</h2>
        <span className="small muted">批次结束（完成、部分失败或取消）时，服务向这些地址发一个带签名的 batch.finished 事件；失败按退避重试。每个租户最多同时启用 10 个。</span>
      </div>
      <form className="fields" onSubmit={(event) => { event.preventDefault(); if (url.trim()) void register(); }}>
        <div className="field wide">
          <label htmlFor="hook-url">接收地址</label>
          <input id="hook-url" type="url" value={url} placeholder="https://" onChange={(event) => setUrl(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="hook-description">说明</label>
          <input id="hook-description" type="text" maxLength={200} value={description} placeholder="可不填" onChange={(event) => setDescription(event.target.value)} />
        </div>
        <div className="field" style={{ justifyContent: 'flex-end', alignItems: 'flex-start' }}>
          <button type="submit" className="primary" disabled={!url.trim() || busy}>{busy ? '正在注册…' : '注册'}</button>
        </div>
      </form>
      {created && <OneTimeSecret title={`${created.url} 的签名密钥`} secret={created.secret}
        note="接收端用它校验请求头 RenderWeave-Signature；做法见开放 API 文档的 webhook 一节。" onClose={() => setCreated(undefined)} />}
      <ErrorBox problems={problems} title="没有完成" />
      <ErrorBox problems={loaded.problems} title="读不到 webhook" />
      <table className="table" style={{ marginTop: 16 }}>
        <thead><tr><th>接收地址</th><th>密钥开头</th><th>注册时间</th><th>状态</th><th><span className="visually-hidden">操作</span></th></tr></thead>
        <tbody>
          {loaded.data?.webhooks.length === 0 && <tr><td colSpan={5} className="muted">还没有 webhook。</td></tr>}
          {loaded.data?.webhooks.map((hook) => (
            <tr key={hook.id} data-testid="webhook-row" data-id={hook.id}>
              <td style={{ wordBreak: 'break-all' }}>{hook.url}{hook.description && <div className="small muted">{hook.description}</div>}</td>
              <td className="mono">{hook.secretPrefix}…</td>
              <td>{time(hook.createdAt)}</td>
              <td><span className={`chip ${hook.active ? 'ok' : 'warn'}`}>{hook.active ? '启用' : '已停用'}</span></td>
              <td className="row-actions">
                <button type="button" className="small quiet" aria-pressed={open?.id === hook.id} onClick={() => setOpen(open?.id === hook.id ? undefined : hook)}>投递记录</button>
                <button type="button" className="small quiet" onClick={() => void toggle(hook)}>{hook.active ? '停用' : '启用'}</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {open && <Deliveries key={open.id} hook={open} />}
    </div>
  );
}

function Deliveries(props: { readonly hook: Webhook }) {
  const deliveries = usePaged((before) => api.webhookDeliveries(props.hook.id, before), props.hook.id);
  return (
    <section className="soft" style={{ marginTop: 16 }} aria-labelledby="deliveries-title">
      <div className="card-head">
        <h3 id="deliveries-title">投递记录 · <span style={{ wordBreak: 'break-all' }}>{props.hook.url}</span></h3>
        <button type="button" className="small quiet" onClick={deliveries.reload}>刷新</button>
      </div>
      <ErrorBox problems={deliveries.problems} title="读不到投递记录" />
      <table className="table">
        <thead><tr><th>记下的时间</th><th>批次</th><th>状态</th><th>最近一次尝试</th></tr></thead>
        <tbody>
          {deliveries.items.map((delivery) => {
            const last = delivery.attempts.at(-1);
            return (
              <tr key={delivery.id} data-testid="delivery-row" data-id={delivery.id} data-status={delivery.status}>
                <td>{time(delivery.createdAt)}</td>
                <td><a className="mono" href={href(['batches', delivery.batchId])}>{delivery.batchId.slice(0, 8)}</a></td>
                <td>
                  <span className={`chip ${delivery.status === 'succeeded' ? 'ok' : delivery.status === 'failed' ? 'bad' : 'accent'}`}>{DELIVERY[delivery.status]}</span>
                  <div className="small muted">试了 {delivery.attempts.length} 次{delivery.status === 'pending' && delivery.nextAttemptAt ? `，下次 ${time(delivery.nextAttemptAt)}` : ''}</div>
                </td>
                <td>{last ? <>{last.statusCode !== undefined ? `HTTP ${last.statusCode}` : last.error} <span className="small muted">· {last.durationMs} ms · {time(last.at)}</span></> : <span className="muted">还没发</span>}</td>
              </tr>
            );
          })}
          {!deliveries.loading && !deliveries.problems && deliveries.items.length === 0 && <tr><td colSpan={4} className="muted">还没有投递：批次结束时才有。</td></tr>}
        </tbody>
      </table>
      <PagedFooter paged={deliveries} />
    </section>
  );
}
