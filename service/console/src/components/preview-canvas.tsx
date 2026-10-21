/**
 * 草稿预览：图片加问题位置。定位到元素的问题按布局摘要里的元素框叠加在图上（毫米换成百分比，不计旋转），
 * 与下方清单同号；点清单里的问题高亮对应的框，字段问题交给表单定位到输入框。
 * 引擎本身也在草稿里画问题边框（docs/render-modes.md），叠加层让人能对上号、点得到。
 */
import { useMemo, useState } from 'react';
import type { LivePreview } from '../hooks.js';
import type { LayoutNode, Problem } from '../types.js';
import { countText, ErrorBox, ProblemList, type ProblemContext } from './problems.js';

function findNode(node: LayoutNode, path: string): LayoutNode | undefined {
  if (node.path === path) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, path);
    if (found) return found;
  }
  return undefined;
}

/** 零宽或零高的元素至少画 2 mm 的标记，与引擎的问题边框一致。 */
const MIN_MARK_MM = 2;

export function PreviewCanvas(props: {
  readonly preview: LivePreview;
  readonly context?: ProblemContext;
  readonly onFieldProblem?: (path: string) => void;
  readonly empty?: string;
}) {
  const { reply, problems: failed, loading, waiting } = props.preview;
  const [selected, setSelected] = useState<Problem>();
  const marks = useMemo(() => {
    const layout = reply?.layout;
    if (!layout || !reply.image) return [];
    const { width, height } = layout.output, result: { problem: Problem; box: { left: number; top: number; width: number; height: number } }[] = [];
    for (const problem of reply.problems) {
      if (problem.location.kind !== 'element') continue;
      const node = findNode(layout.root, problem.location.path);
      if (!node || !node.visible) continue;
      const w = Math.max(node.width, MIN_MARK_MM), h = Math.max(node.height, MIN_MARK_MM);
      const x = node.x - (w - node.width) / 2, y = node.y - (h - node.height) / 2;
      result.push({ problem, box: { left: (x / width) * 100, top: (y / height) * 100, width: (w / width) * 100, height: (h / height) * 100 } });
    }
    return result;
  }, [reply]);
  const numbers = useMemo(() => new Map(marks.map((mark, index) => [mark.problem, index + 1])), [marks]);
  const select = (problem: Problem) => {
    setSelected(problem);
    if (problem.location.kind === 'field') props.onFieldProblem?.(problem.location.path);
  };
  const image = reply?.image;

  return (
    <div className="preview">
      <div className="preview-status" aria-live="polite">
        {waiting ? '预览太频繁，稍后自动重试…' : loading ? '正在出草稿预览…' : reply ? `草稿预览${image ? ` · ${image.widthPx} × ${image.heightPx} 像素` : ' · 无法展开，没有图片'} · ${countText(reply.problems)}` : ''}
        <button type="button" className="link" onClick={props.preview.refresh}>刷新预览</button>
      </div>
      <div className={`stage${loading ? ' busy' : ''}`}>
        {image ? (
          <div className="canvas">
            <img data-testid="preview-image" src={`data:image/${image.format};base64,${image.base64}`} alt="草稿预览" width={image.widthPx} height={image.heightPx} />
            {marks.map(({ problem, box }) => (
              <button
                type="button" key={numbers.get(problem)} data-testid="problem-mark"
                className={`mark ${problem.level}${problem === selected ? ' selected' : ''}`}
                style={{ left: `${box.left}%`, top: `${box.top}%`, width: `${box.width}%`, height: `${box.height}%` }}
                title={problem.message} aria-label={`问题 ${numbers.get(problem)}：${problem.message}`}
                onClick={() => setSelected(problem)}
              >
                <span className="marker-number">{numbers.get(problem)}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="stage-empty">{reply ? '没有图片：问题见下方清单' : props.empty ?? '还没有预览'}</div>
        )}
      </div>
      <ErrorBox problems={failed} title="预览失败" />
      {reply && <ProblemList problems={reply.problems} context={props.context} numbers={numbers} selected={selected} onSelect={select} label="预览的问题" />}
    </div>
  );
}
