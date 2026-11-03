/**
 * 登录（M247、M361）：成员用邮箱加密码登录，会话 12 小时；只有客户管理员与操作员能用控制台。
 * 版式照原型：左上品牌，表单直接放在页面上，右边大幅视频，不放说明文字。
 * 视频没有声音、不放控件；减少动态时只放封面，窄窗口不放（也就不下载）。
 */
import { useState, useSyncExternalStore, type FormEvent } from 'react';
import { api, session } from '../api.js';
import studioPoster from '../assets/login-studio.jpg';
import studioVideo from '../assets/login-studio.mp4';
import { Logo } from '../components/logo.js';
import { ErrorBox } from '../components/problems.js';
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
      <StudioVideo />
    </main>
  );
}

const useMedia = (query: string) => useSyncExternalStore((changed) => {
  const list = window.matchMedia(query);
  list.addEventListener('change', changed);
  return () => list.removeEventListener('change', changed);
}, () => window.matchMedia(query).matches);

/** 右边的视频：控制台的配色就取自它（M361）。 */
function StudioVideo() {
  const wide = useMedia('(min-width: 861px)'), still = useMedia('(prefers-reduced-motion: reduce)');
  if (!wide) return null;
  return (
    <div className="login-art" aria-hidden="true">
      {still ? <img src={studioPoster} alt="" /> : <video src={studioVideo} poster={studioPoster} autoPlay muted loop playsInline disablePictureInPicture />}
    </div>
  );
}
