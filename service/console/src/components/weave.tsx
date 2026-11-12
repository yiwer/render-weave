import type { CSSProperties } from 'react';

/**
 * 登录页右边的织面（M398）：墨黑的底上一幅自己画的提花，纬线一行一行织出菱形花纹。
 * 整幅是页面里的 SVG，不下载图片或视频；动效在样式表里（.weave-row），减少动态时停在织完的样子。
 */
const COLS = 24, ROWS = 32, CELL = 20, FLOAT = 12;
const BANDS = ['paper', 'ground', 'amber', 'ground', 'indigo', 'ground', 'amber', 'ground', 'indigo'] as const;
type Tone = typeof BANDS[number];

/** 这一格纬线是什么颜色；没有就是纬线沉到经线下面，露出经线。 */
const toneAt = (column: number, row: number): Tone | undefined => {
  const distance = Math.abs(column - (COLS - 1) / 2) + Math.abs(row - (ROWS - 1) / 2) * 0.75;
  const tone = BANDS[Math.floor(distance / 2)] ?? 'ground';
  return tone === 'ground' && (column + row) % 4 === 0 ? undefined : tone;
};

/** 同色相邻的格子并成一段浮线。 */
const floats = (row: number) => {
  const runs: { readonly tone: Tone; readonly from: number; readonly cells: number }[] = [];
  for (let column = 0; column < COLS; column += 1) {
    const tone = toneAt(column, row), last = runs.at(-1);
    if (!tone) continue;
    if (last && last.tone === tone && last.from + last.cells === column) runs[runs.length - 1] = { ...last, cells: last.cells + 1 };
    else runs.push({ tone, from: column, cells: 1 });
  }
  return runs;
};

const WEFTS = Array.from({ length: ROWS }, (_, row) => floats(row));

export function Weave() {
  return (
    <svg viewBox={`0 0 ${COLS * CELL} ${ROWS * CELL}`} preserveAspectRatio="xMidYMid slice" data-testid="login-weave">
      {Array.from({ length: COLS }, (_, column) => <rect key={column} className="weave-warp" x={column * CELL + CELL / 2 - 1.5} y="0" width="3" height={ROWS * CELL} />)}
      {WEFTS.map((runs, row) => (
        <g key={row} className="weave-row" style={{ '--row': row } as CSSProperties}>
          {runs.map((run) => <rect key={run.from} className={`weave-${run.tone}`} x={run.from * CELL + 2} y={row * CELL + (CELL - FLOAT) / 2} width={run.cells * CELL - 4} height={FLOAT} rx="2" />)}
        </g>
      ))}
    </svg>
  );
}
