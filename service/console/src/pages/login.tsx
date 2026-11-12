/**
 * 登录（M247、M398）：成员用邮箱加密码登录，会话 12 小时；只有客户管理员与操作员能用控制台。
 * 版式：左上品牌，表单直接放在页面上，右边一幅织面，不放说明文字。
 * 织面是页面里自己画的 SVG；减少动态时停在织完的样子，窄窗口不放。
 */
import { useState, useSyncExternalStore, type FormEvent } from 'react';
import { api, session } from '../api.js';
import { Logo } from '../components/logo.js';
import { ErrorBox } from '../components/problems.js';
import { Weave } from '../components/weave.js';
import { problemsOf } from '../hooks.js';
import type { Identity, Problem } from '../types.js';

export function LoginPage(props: { readonly notice?: string; readonly onLogin: (identity: Identity) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
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
      <h1 className="brand login-brand"><Logo size={28} />RenderWeave</h1>
      <form className="login-card" onSubmit={(event) => void submit(event)} aria-label="登录">
        <h2 className="login-title">登录控制台</h2>
        {props.notice && <p className="notice" role="status">{props.notice}</p>}
        <input type="email" aria-label="邮箱" placeholder="输入邮箱" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} />
        <div className="password-field">
          <input type={showPassword ? 'text' : 'password'} aria-label="密码" placeholder="输入密码" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
          <button type="button" className="link" aria-pressed={showPassword} onClick={() => setShowPassword(!showPassword)}>{showPassword ? '隐藏' : '显示'}</button>
        </div>
        <ErrorBox problems={problems} />
        <button type="submit" className="primary" disabled={busy}>
          {busy ? '正在登录…' : <>登录<svg className="login-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg></>}
        </button>
      </form>
      <WeaveArt />
    </main>
  );
}

const useMedia = (query: string) => useSyncExternalStore((changed) => {
  const list = window.matchMedia(query);
  list.addEventListener('change', changed);
  return () => list.removeEventListener('change', changed);
}, () => window.matchMedia(query).matches);

/** 右边的织面：窄窗口不放。 */
function WeaveArt() {
  const wide = useMedia('(min-width: 861px)');
  if (!wide) return null;
  return <div className="login-art" aria-hidden="true"><Weave /></div>;
}
