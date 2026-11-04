/**
 * 控制台的灵动小图（M361）：圆头细线、弹簧缓动，母题是 RenderWeave 的两根织线与纸页。
 * 动画都在 styles.css（内容安全策略不许内联 <style>）；减少动态时不动，静止的样子就是完成态。都是装饰，对读屏隐藏。
 */
import type { CSSProperties, ReactNode } from 'react';

const icon = (size: number) => ({ width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true } as const);
const spot = (size: number) => ({ width: size, height: size, viewBox: '0 0 120 120', fill: 'none', 'aria-hidden': true } as const);

/** 织线星轨：正在读取、正在校验。两条轨道反向转，中间是打了结的两根织线。 */
export function ThreadOrbit(props: { readonly size?: number }) {
  return (
    <svg className="motif motif-orbit" {...icon(props.size ?? 20)}>
      <g className="orbit-a">
        <ellipse className="m-slate" cx="12" cy="12" rx="10.4" ry="4.6" strokeDasharray="3 2.4" transform="rotate(-28 12 12)" />
        <circle className="m-fill-clay" cx="22.4" cy="12" r="1.5" transform="rotate(-28 12 12)" />
      </g>
      <g className="orbit-b">
        <ellipse className="m-ochre" cx="12" cy="12" rx="10.4" ry="5.2" strokeDasharray="9 3 2 3" transform="rotate(42 12 12)" />
        <circle className="m-fill-olive" cx="1.6" cy="12" r="1.3" transform="rotate(42 12 12)" />
      </g>
      <g className="orbit-knot m-ink">
        <path d="M8.5 10.2c2.3 0 2.3 3.6 4.6 3.6s2.4-3.6 2.4-3.6" />
        <path d="M8.5 13.8c2.3 0 2.3-3.6 4.6-3.6" />
      </g>
    </svg>
  );
}

/** "正在读取…"：文字照旧在，前面多一个在转的织线星轨。 */
export function Loading(props: { readonly children?: ReactNode; readonly role?: 'status' }) {
  return <p className="muted loading" {...(props.role ? { role: props.role } : {})}><ThreadOrbit />{props.children ?? '正在读取…'}</p>;
}

/** 印章：校验通过、任务完成。外圈与对勾各描一笔，描完就停在完成态；悬停时外圈转一下。 */
export function Seal(props: { readonly size?: number }) {
  return (
    <svg className="motif motif-seal" {...icon(props.size ?? 18)}>
      <circle className="m-fill-soft" cx="12" cy="12" r="9.6" />
      <circle className="seal-ring m-olive" cx="12" cy="12" r="9.6" pathLength={100} />
      <path className="seal-check m-olive" d="M7.4 12.5l3 3c1.3-2.8 3.3-5.4 6.2-6.9" pathLength={100} />
    </svg>
  );
}

/** 沙漏：出图任务进行中。三粒沙错开下落。 */
export function Hourglass(props: { readonly size?: number }) {
  return (
    <svg className="motif motif-hourglass" {...icon(props.size ?? 20)}>
      <path className="m-ink" d="M6 3h12M6 21h12" />
      <path className="m-ink" d="M7.6 3c0 4.6 3.2 6.2 3.2 9s-3.2 4.4-3.2 9h8.8c0-4.6-3.2-6.2-3.2-9s3.2-4.4 3.2-9z" />
      <path className="m-fill-ochre" d="M9.2 6.4h5.6c-.5 1.8-2 3.4-2.8 4.4-.8-1-2.3-2.6-2.8-4.4z" />
      <path className="m-fill-clay" d="M8.8 20.6c.3-2 1.6-3.4 3.2-3.4s2.9 1.4 3.2 3.4z" />
      <circle className="grain m-fill-clay" cx="12" cy="12" r=".75" />
      <circle className="grain m-fill-ochre" cx="12" cy="12" r=".7" />
      <circle className="grain m-fill-clay" cx="12" cy="12" r=".65" />
    </svg>
  );
}

/** 纸页与笔迹：还没有草案。正文一行行写出来；悬停时底下两页散开。 */
export function DraftSheets(props: { readonly size?: number }) {
  return (
    <svg className="motif motif-sheets" {...spot(props.size ?? 104)}>
      <rect className="sheet-left m-sheet m-line" x="32" y="26" width="52" height="68" rx="6" />
      <rect className="sheet-right m-sheet m-slate" x="36" y="26" width="52" height="68" rx="6" />
      <g className="sheet-main">
        <rect className="m-page m-ink" x="32" y="22" width="56" height="74" rx="6" />
        <rect className="sheet-mark m-fill-soft" x="39" y="47" width="38" height="9" rx="3" />
        <g className="m-clay">
          <path d="M41 35c2.8 0 2.8 5 5.6 5s2.9-5 2.9-5" />
          <path d="M41 40c2.8 0 2.8-5 5.6-5" />
        </g>
        <path className="m-write m-ink" pathLength={100} d="M56 37.5h22" />
        <path className="m-write m-clay" pathLength={100} d="M41 51.5h34" />
        <path className="m-write m-slate" pathLength={100} d="M41 62h32" />
        <path className="m-write m-olive" pathLength={100} d="M41 72h24" />
        <path className="m-write m-slate" pathLength={100} d="M41 82h16" />
      </g>
    </svg>
  );
}

/** 字段的连线：还没有已发布的版本。信号沿织线传过去，节点轻轻浮动；悬停时聚拢出一圈。 */
export function FieldGraph(props: { readonly size?: number }) {
  const nodes: readonly (readonly [string, number, number, number, string])[] = [
    ['float-a', 26, 30, 5, 'ink'], ['float-b', 94, 34, 5.5, 'olive'], ['float-a', 36, 94, 5, 'ochre'], ['float-b', 92, 88, 4.5, 'slate'],
  ];
  return (
    <svg className="motif motif-graph" {...spot(props.size ?? 104)}>
      <circle className="graph-ring m-ochre" cx="58" cy="60" r="36" strokeDasharray="3 5" />
      <path className="m-slate graph-thread" d="M26 30 Q44 50 58 60 T94 34" />
      <path className="m-slate graph-thread" d="M36 94 Q48 78 58 60 Q76 76 92 88" />
      <path className="m-clay graph-signal" pathLength={100} d="M26 30 Q44 50 58 60 T94 34" />
      <path className="m-olive graph-signal reverse" pathLength={100} d="M36 94 Q48 78 58 60 Q76 76 92 88" />
      {nodes.map(([motion, x, y, r, tone]) => (
        <g key={`${x}:${y}`} className={motion}>
          <circle className="m-page" cx={x} cy={y} r={r} stroke={`var(--${tone})`} />
          <circle cx={x} cy={y} r={r * .42} fill={`var(--${tone})`} />
        </g>
      ))}
      <circle className="graph-core-glow m-fill-clay" cx="58" cy="60" r="13" />
      <circle className="m-page m-clay" cx="58" cy="60" r="7.5" />
      <circle className="m-fill-clay" cx="58" cy="60" r="3.2" />
    </svg>
  );
}

/** 用量的天平：用得越多越往右沉，快到限额时右边多压一块。 */
export function UsageBeam(props: { readonly ratio: number; readonly size?: number }) {
  const ratio = Math.min(Math.max(props.ratio, 0), 1), tilt = Math.round((ratio - .5) * 24);
  return (
    <svg className="motif motif-beam" data-testid="usage-beam" data-tilt={tilt} {...spot(props.size ?? 84)}>
      <path className="m-ink" d="M36 98h48" />
      <path className="m-sheet m-ink" d="M50 98l10-26 10 26z" />
      <circle className="m-fill-clay" cx="60" cy="72" r="3" />
      <g className="beam" style={{ '--tilt': `${tilt}deg` } as CSSProperties}>
        <path className="m-ink" d="M20 72h80" />
        <circle className="m-fill-soft m-olive" cx="32" cy="60" r="10" />
        <circle className="m-fill-olive" cx="32" cy="60" r="2.8" />
        <rect className="m-fill-soft m-clay" x="77" y="50" width="20" height="20" rx="3" />
        {ratio >= .8 && <rect className="beam-weight m-ochre" x="81" y="38" width="12" height="10" rx="2" />}
      </g>
    </svg>
  );
}
