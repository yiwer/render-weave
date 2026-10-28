/** 登录：成员用邮箱加密码登录（M247），会话 12 小时；只有客户管理员与操作员能用控制台。 */
import { useState, type CSSProperties, type FormEvent } from 'react';
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
      <div className="login-art" aria-hidden="true"><Weave /></div>
    </main>
  );
}

/** 登录页右侧的织线图案：经线与纬线交织，两根调和橙的织线上有亮线段流动（减少动态时不动）。 */
function Weave() {
  const rows = [60, 120, 180, 240, 300], columns = [70, 150, 230, 310];
  return (
    <svg viewBox="0 0 380 360" fill="none" strokeLinecap="round">
      {columns.map((x) => <path key={x} d={`M${x} 30v300`} stroke="#D9C8B0" strokeWidth="10" />)}
      {rows.map((y, row) => (
        <path key={y} stroke="#BFAA8E" strokeWidth="10"
          d={`M30 ${y}${columns.map((x, column) => ` Q${x} ${y + ((row + column) % 2 ? 14 : -14)} ${x + 40} ${y}`).join('')}`} />
      ))}
      <g className="loom" stroke="#F17D13" strokeWidth="6">
        <path d="M40 150c90 0 90 80 180 80s90-80 140-80" opacity="0.35" />
        <path className="shuttle" d="M40 150c90 0 90 80 180 80s90-80 140-80" style={{ '--len': 360 } as CSSProperties} />
      </g>
    </svg>
  );
}
