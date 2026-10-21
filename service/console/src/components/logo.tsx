/** RenderWeave 的标志：经纬交织。 */
export function Logo(props: { readonly size?: number }) {
  const size = props.size ?? 28;
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden="true">
      <rect x="1" y="1" width="26" height="26" rx="8" fill="#071a31" />
      <path d="M7 10h14M7 14h14M7 18h14" stroke="#fcfbf8" strokeWidth="2" />
      <path d="M11 7v14M17 7v14" stroke="#4c8dff" strokeWidth="2" />
    </svg>
  );
}
