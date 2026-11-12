import type { CSSProperties } from 'react';

const len = (value: number) => ({ '--len': value }) as CSSProperties;

/**
 * RenderWeave 的标志（M398）：经线色的方块上一小块平纹，两根纬线（橙）、两根经线（白），一上一下交织。
 * 打开页面时先描纬线、再描经线、最后压上浮点；悬停再描一遍，减少动态时不动。
 */
export function Logo(props: { readonly size?: number }) {
  const size = props.size ?? 22;
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="none" strokeWidth="2.4" strokeLinecap="round">
      <rect width="24" height="24" rx="5" fill="var(--accent)" />
      <path d="M5 9h14" stroke="var(--mark)" style={len(14)} />
      <path d="M5 15h14" stroke="var(--mark)" style={len(14)} />
      <path d="M9 5v14" stroke="#FFFFFF" style={len(14)} />
      <path d="M15 5v14" stroke="#FFFFFF" style={len(14)} />
      <path d="M13 9h4" stroke="var(--mark)" strokeLinecap="butt" style={len(4)} />
      <path d="M7 15h4" stroke="var(--mark)" strokeLinecap="butt" style={len(4)} />
    </svg>
  );
}

/** 织梭：两根纬线上有亮线段来回走，表示正在进行（状态栏里的进行中批次）。 */
export function Loom() {
  return (
    <svg className="loom" width="13" height="13" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="var(--mark)" strokeWidth="2.6" strokeLinecap="round">
      <path d="M4 8h16" opacity="0.3" />
      <path d="M4 16h16" opacity="0.3" />
      <path className="shuttle" d="M4 8h16" style={len(16)} />
      <path className="shuttle" d="M20 16H4" style={len(16)} />
    </svg>
  );
}
