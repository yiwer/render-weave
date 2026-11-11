/**
 * "连接数据…"的那张单子（第三轮票据 07）：列出类型和这个元素相符的字段与变量，选一个就连上。
 * 列哪些、选了写什么都在 template/connect.ts；右键菜单用它，票据 13 的选中条也用它。
 */
import { TYPE_GLYPHS } from '../components/value-text.js';
import type { ConnectChoice, DataSource } from '../template/connect.js';

export function ConnectList(props: { readonly choices: readonly ConnectChoice[]; readonly onChoose: (source: DataSource) => void }) {
  return (
    <div className="connect-list" role="group" aria-label="连接数据" data-testid="connect-list">
      {props.choices.length === 0 && <span className="small muted menu-empty">没有类型相符的字段或变量</span>}
      {props.choices.map((choice) => (
        <button key={choice.source.name} type="button" role="menuitem" data-testid="connect-choice" data-name={choice.source.name} data-effect={choice.effect} disabled={choice.current}
          title={choice.source.name} onClick={() => props.onChoose(choice.source)}>
          <span className="variable-glyph mono" aria-hidden="true">{TYPE_GLYPHS[choice.source.type] ?? '·'}</span>
          <span className="variable-name">{choice.source.label}<span className="variable-key mono">{choice.source.name}</span></span>
          <span className="small faint">{choice.current ? '已连着' : choice.what}</span>
        </button>
      ))}
    </div>
  );
}
