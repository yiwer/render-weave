/**
 * 发布确认卡（M381）：结论、版本走向、几条后果和发布按钮，吸在视口里，读到哪都能发。
 * 数据定义与模板两个发布页共用；结论怎么来的在 form/publish-verdict.ts，按钮由页面放进来。
 */
import type { ReactNode } from 'react';
import type { PublishTone, PublishVerdict } from '../form/publish-verdict.js';
import { ALERT, CHECK, CROSS, Icon } from './icon.js';
import { VersionThread } from './motifs.js';

const MARK: Readonly<Record<PublishTone, string>> = { ok: CHECK, warn: ALERT, bad: CROSS };

export function PublishConfirm(props: {
  readonly verdict: PublishVerdict;
  /** 版本走向：有严重问题、发不出新版本时没有。 */
  readonly steps?: { readonly from: string; readonly to: string };
  readonly busy?: boolean;
  readonly children?: ReactNode;
}) {
  const { verdict, steps } = props;
  return (
    <aside className="publish-confirm" aria-label="发布确认" aria-busy={props.busy ?? false} data-testid="publish-confirm" data-tone={verdict.tone}>
      <div className="publish-confirm-head">
        <span className={`publish-state ${verdict.tone}`}>{verdict.label}</span>
        {steps && (
          <div className="version-strip">
            <span className="version-step from">{steps.from}</span>
            <VersionThread />
            <span className="version-step to">{steps.to}</span>
          </div>
        )}
      </div>
      <ul className="publish-checks">
        {verdict.lines.map((line) => (
          <li key={line.key} className={line.tone} data-check={line.key} data-tone={line.tone}>
            <span className="publish-check-mark"><Icon d={MARK[line.tone]} /></span>
            <span className="publish-check-text">{line.text}</span>
            {line.note && <small className="publish-check-note">{line.note}</small>}
          </li>
        ))}
      </ul>
      {props.children && <div className="publish-confirm-actions">{props.children}</div>}
    </aside>
  );
}
