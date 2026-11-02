/** 只出现一次的密钥：关掉就没了。复制在 http 地址上可能不可用，那时手动选中复制。 */
import { useState } from 'react';

export function OneTimeSecret(props: { readonly title: string; readonly secret: string; readonly note: string; readonly onClose: () => void }) {
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
