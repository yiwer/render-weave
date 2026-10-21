/**
 * 出图控制台（票据 12，M248、M279、M282）：开放 API 的网页客户端，由接口进程在 /console/ 下提供。
 * 结构按原型方案一，以数据集为中心：首页是数据集，打开一份数据集就是左表单、右草稿预览，出图在侧栏里进行。
 * 登录后按 # 路由切换页面；界面只做中文。
 */
import { useEffect, useState } from 'react';
import { api, onUnauthorized, session } from './api.js';
import { Logo } from './components/logo.js';
import { href, useRoute } from './hooks.js';
import { DatasetEditor, DatasetList } from './pages/datasets.js';
import { BatchPage } from './pages/deliver.js';
import { LoginPage } from './pages/login.js';
import { TemplateList, TemplateStudio } from './pages/templates.js';
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

/** 本月剩余张数：只有能看用量的身份（客户管理员）才显示，操作员读不到用量（M247）。 */
function Quota() {
  const [text, setText] = useState<string>();
  useEffect(() => {
    let live = true;
    api.usage().then((usage) => {
      if (live) setText(`本月剩余 ${usage.images.remaining.toLocaleString('zh-CN')} / ${usage.images.limit.toLocaleString('zh-CN')} 张`);
    }, () => undefined);
    return () => { live = false; };
  }, []);
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
    default: page = <p className="page muted">没有这个页面。<a href={href(['datasets'])}>回到数据集</a></p>;
  }
  const active = section === 'templates' ? 'templates' : 'datasets';
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
        </nav>
        <div className="account">
          <Quota />
          <span className="who" title={props.identity.email}>{props.identity.email} · {ROLE[props.identity.role] ?? props.identity.role}</span>
          <button type="button" className="small quiet" onClick={props.onLogout}>退出</button>
        </div>
      </header>
      <main>{page}</main>
    </>
  );
}
