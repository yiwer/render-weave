/**
 * 出图控制台（票据 12，M248、M279、M282）：开放 API 的网页客户端，由接口进程在 /console/ 下提供。
 * 结构按原型方案一，以数据集为中心：首页是数据集，打开一份数据集就是左表单、右草稿预览，出图在侧栏里进行。
 * 票据 14 加了出图记录、资源、用量与管理（M301）：管理只给客户管理员，操作员的导航里没有它。
 * 登录后按 # 路由切换页面；界面只做中文。
 */
import { useEffect, useState } from 'react';
import { api, onUnauthorized, onUsageChanged, session } from './api.js';
import { Logo } from './components/logo.js';
import { href, useRoute } from './hooks.js';
import { AdminPage } from './pages/admin.js';
import { DatasetEditor, DatasetList } from './pages/datasets.js';
import { BatchPage } from './pages/deliver.js';
import { LoginPage } from './pages/login.js';
import { RecordsPage } from './pages/records.js';
import { ResourcesPage } from './pages/resources.js';
import { TemplateList, TemplateStudio } from './pages/templates.js';
import { UsagePage } from './pages/usage.js';
import type { Identity } from './types.js';

const ROLE: Readonly<Record<string, string>> = { admin: '客户管理员', operator: '客户操作员', platformAdmin: '平台管理员', apiKey: 'API 密钥', authoringEngineer: '代建工程师' };

export function App() {
  // undefined：正在确认会话；null：没有登录。
  const [identity, setIdentity] = useState<Identity | null | undefined>(session.token ? undefined : null);
  const [notice, setNotice] = useState<string>();
  useEffect(() => {
    onUnauthorized(() => { setNotice('登录已失效，请重新登录'); setIdentity(null); });
    if (session.token) api.me().then(setIdentity, () => setIdentity(null));
  }, []);
  const logout = async () => {
    try { await api.logout(); } catch { /* 会话已失效也照样退出 */ }
    session.clear();
    setNotice('已退出');
    setIdentity(null);
  };

  if (identity === undefined) return <p className="boot">正在打开…</p>;
  if (identity === null) return <LoginPage {...(notice ? { notice } : {})} onLogin={(next) => { setNotice(undefined); setIdentity(next); }} />;
  if (identity.kind !== 'member') {
    return (
      <main className="login">
        <div className="login-card">
          <span className="brand"><Logo />RenderWeave</span>
          <p>出图控制台给客户的管理员与操作员使用。当前账号是{ROLE[identity.role] ?? identity.role}，请改用租户成员的账号登录。</p>
          <button type="button" className="primary" onClick={() => void logout()}>退出</button>
        </div>
      </main>
    );
  }
  return <Shell identity={identity} onLogout={() => void logout()} />;
}

/**
 * 本月剩余张数：客户管理员与操作员都看得到（M300）。提交、取消批次与批次结束时重新读取；
 * 换页时也读一次，别的成员或 API 密钥出的图在这里看得到。
 */
function Quota(props: { readonly page: string }) {
  const [text, setText] = useState<string>();
  const [version, setVersion] = useState(0);
  useEffect(() => onUsageChanged(() => setVersion((value) => value + 1)), []);
  useEffect(() => {
    let live = true;
    api.usage().then((usage) => {
      if (live) setText(`本月剩余 ${usage.images.remaining.toLocaleString('zh-CN')} / ${usage.images.limit.toLocaleString('zh-CN')} 张`);
    }, () => undefined);
    return () => { live = false; };
  }, [props.page, version]);
  return text ? <span className="quota" data-testid="quota">{text}</span> : null;
}

function Shell(props: { readonly identity: Identity; readonly onLogout: () => void }) {
  const { path, query } = useRoute();
  const [section = 'datasets', id, sub, subId] = path;
  let page;
  switch (section) {
    case 'datasets':
      if (id === 'new') page = <DatasetEditor key={`new:${query.get('template') ?? ''}`} {...(query.get('template') ? { templateName: query.get('template')! } : {})} />;
      else if (id) {
        page = <DatasetEditor key={id} id={id} {...(query.get('template') ? { templateName: query.get('template')! } : {})}
          sheet={sub === 'deliver' ? { kind: 'deliver' } : sub === 'batches' && subId ? { kind: 'batch', id: subId } : undefined} />;
      } else page = <DatasetList />;
      break;
    case 'deliver':
      page = <DatasetList deliver={{ datasetIds: (query.get('datasets') ?? '').split(',').filter(Boolean), ...(query.get('template') ? { templateName: query.get('template')! } : {}) }} />;
      break;
    case 'import': page = <DatasetList importing={query.get('template') ? { templateName: query.get('template')! } : {}} />; break;
    case 'templates': page = id ? <TemplateStudio name={id} /> : <TemplateList />; break;
    case 'batches': page = id ? <BatchPage id={id} /> : <DatasetList />; break;
    case 'records': page = <RecordsPage key={query.toString()} query={query} />; break;
    case 'resources': page = <ResourcesPage identity={props.identity} />; break;
    case 'usage': page = <UsagePage identity={props.identity} {...(query.get('period') ? { period: query.get('period')! } : {})} />; break;
    case 'admin': page = <AdminPage identity={props.identity} {...(id ? { tab: id } : {})} />; break;
    default: page = <p className="page muted">没有这个页面。<a href={href(['datasets'])}>回到数据集</a></p>;
  }
  const active = ['templates', 'records', 'resources', 'usage', 'admin'].includes(section) ? section : 'datasets';
  const tab = (name: string, label: string) => (
    <a href={href([name])} className={active === name ? 'active' : undefined} aria-current={active === name ? 'page' : undefined}>{label}</a>
  );
  return (
    <>
      <header className="topbar">
        <a className="brand" href={href(['datasets'])}><Logo />RenderWeave</a>
        <nav aria-label="主导航">
          {tab('datasets', '数据集')}
          {tab('templates', '模板')}
          {tab('records', '出图记录')}
          {tab('resources', '资源')}
          {tab('usage', '用量')}
          {props.identity.role === 'admin' && tab('admin', '管理')}
        </nav>
        <div className="account">
          <Quota page={path.join('/')} />
          <span className="who" title={props.identity.email}>{props.identity.email} · {ROLE[props.identity.role] ?? props.identity.role}</span>
          <button type="button" className="small quiet" onClick={props.onLogout}>退出</button>
        </div>
      </header>
      <main>{page}</main>
    </>
  );
}
