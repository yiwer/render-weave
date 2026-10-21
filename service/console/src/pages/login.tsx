/** 登录：成员用邮箱加密码登录（M247），会话 12 小时；只有客户管理员与操作员能用控制台。 */
import { useState, type FormEvent } from 'react';
import { api, session } from '../api.js';
import { Logo } from '../components/logo.js';
import { ErrorBox } from '../components/problems.js';
import { problemsOf } from '../hooks.js';
import type { Identity, Problem } from '../types.js';

export function LoginPage(props: { readonly notice?: string; readonly onLogin: (identity: Identity) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<readonly Problem[]>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblems(undefined);
    try {
      const reply = await api.login(email.trim(), password);
      session.set(reply.token);
      props.onLogin(reply.identity);
    } catch (error) { setProblems(problemsOf(error)); }
    finally { setBusy(false); }
  };

  return (
    <main className="login">
      <form className="login-card" onSubmit={(event) => void submit(event)} aria-label="登录">
        <h1 className="brand"><Logo />RenderWeave</h1>
        <p className="muted">出图控制台：填数据、看草稿预览、正式出图与下载。</p>
        {props.notice && <p className="notice" role="status">{props.notice}</p>}
        <div className="field">
          <label htmlFor="login-email">邮箱</label>
          <input id="login-email" type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="login-password">密码</label>
          <input id="login-password" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
        </div>
        <ErrorBox problems={problems} />
        <button type="submit" className="primary" disabled={busy}>{busy ? '正在登录…' : '登录'}</button>
        <p className="muted small">账号由平台管理员开通；忘记密码请联系管理员重置。</p>
      </form>
    </main>
  );
}
