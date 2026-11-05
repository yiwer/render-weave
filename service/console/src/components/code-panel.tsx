/** 看一份 JSON 文档（编译产物、数据定义 DSL）：能复制、能下载。 */
import { useState } from 'react';
import { saveBlob } from '../api.js';

export function CodePanel(props: { readonly testid: string; readonly value: unknown; readonly file: string; readonly type: string }) {
  const text = `${JSON.stringify(props.value, null, 2)}\n`;
  const [copied, setCopied] = useState<string>();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied('已复制');
    } catch { setCopied('浏览器不让复制，请手动选中'); }
  };
  return (
    <section className="code-panel">
      <div className="actions code-panel-tools">
        {copied && <span className="small muted" role="status">{copied}</span>}
        <button type="button" className="small quiet" onClick={() => void copy()}>复制</button>
        <button type="button" className="small quiet" onClick={() => saveBlob(new Blob([text], { type: props.type }), props.file.replace(/[\\/:*?"<>|]/g, '_'))}>下载</button>
      </div>
      <pre className="compiled" data-testid={props.testid} tabIndex={0}>{text}</pre>
    </section>
  );
}
