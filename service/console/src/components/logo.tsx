import type { CSSProperties } from 'react';

/** RenderWeave 的标志（M361）：藏青的方块上一根白线、一根铅笔赭的线交织；打开页面时描一遍线，悬停再描一遍，减少动态时不动。 */
export function Logo(props: { readonly size?: number }) {
  const size = props.size ?? 22;
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect width="24" height="24" rx="6" fill="var(--accent)" />
      <path d="M6 8.5c4 0 4 7 8 7s4-7 4-7" stroke="#FFFFFF" strokeWidth="2" fill="none" strokeLinecap="round" style={{ '--len': 21 } as CSSProperties} />
      <path d="M6 15.5c4 0 4-7 8-7" stroke="#D9A566" strokeWidth="2" fill="none" strokeLinecap="round" style={{ '--len': 12 } as CSSProperties} />
    </svg>
  );
}

/** 织梭：两根织线上有亮线段流动，表示正在进行（状态栏里的进行中批次）。 */
export function Loom() {
  return (
    <svg className="loom" width="13" height="13" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="var(--mark)" strokeWidth="2.4" strokeLinecap="round">
      <path d="M6 8.5c4 0 4 7 8 7s4-7 4-7" opacity="0.3" />
      <path d="M6 15.5c4 0 4-7 8-7" opacity="0.3" />
      <path className="shuttle" d="M6 8.5c4 0 4 7 8 7s4-7 4-7" style={{ '--len': 21 } as CSSProperties} />
      <path className="shuttle" d="M6 15.5c4 0 4-7 8-7" style={{ '--len': 12 } as CSSProperties} />
    </svg>
  );
}
