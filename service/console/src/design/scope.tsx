/**
 * 范围条（模板设计页票据 04，方案第 3 节）：选中的是谁，改了影响谁。元素路径每段可点，跨模板的段换颜色；
 * 写明定义在哪个模板、图上几处、这是第几处。图上多处时的影响在检查器顶部再说一遍（impactOf）。
 */
import { Fragment } from 'react';
import type { PreviewReply } from '../types.js';
import type { Selection } from './stage.js';

/** 选中元素在图上的实例，来自预览的元素定位；当前数据下不显示的元素没有实例。 */
export function instancesOf(reply: PreviewReply | undefined, selected: Selection | undefined): readonly string[] {
  if (!selected || !reply?.elements) return [];
  return reply.elements.filter((element) => element.source.template === selected.template && element.source.path === selected.path).map((element) => element.path);
}

/** 影响范围的一句话：图上多于一处，或者定义在子模板里时才说。 */
export function impactOf(root: string, selected: Selection | undefined, count: number): string | undefined {
  if (!selected) return undefined;
  if (count > 1) return `这里改的是模板「${selected.template}」，图上 ${count} 处一起变。`;
  return selected.template !== root ? `这里改的是子模板「${selected.template}」，不是这张图独有。` : undefined;
}

export function ScopeBar(props: { readonly root: string; readonly name: string; readonly selected?: Selection; readonly reply?: PreviewReply; readonly left: number; readonly right: number; readonly onPick: (instance: string) => void }) {
  const { root, name, selected, reply } = props;
  const instances = instancesOf(reply, selected);
  const main = selected?.instance && instances.includes(selected.instance) ? selected.instance : instances[0];
  const shown = main ?? selected?.path ?? name;
  const segments = shown.split('/');
  const sources = new Map((reply?.elements ?? []).map((element) => [element.path, element.source.template]));
  const prefixes = segments.map((_, index) => segments.slice(0, index + 1).join('/'));
  const template = selected?.template ?? name;
  const where = instances.length > 1
    ? <>定义在 <strong>{template}</strong>，图上 <strong>{instances.length}</strong> 处{main ? `，这是第 ${instances.indexOf(main) + 1} 处` : ''}，改一处全改</>
    : selected && instances.length === 0 && selected.path !== selected.template ? <>定义在 <strong>{template}</strong>，当前样例不显示</>
    : template === root ? <>属于模板 <strong>{template}</strong></> : <>定义在 <strong>{template}</strong></>;
  return (
    <div className="design-scope-wrap" style={{ left: props.left, right: props.right }}>
      <div className="design-scope" data-testid="design-scope" data-path={shown} data-count={instances.length}>
        <span className="scope-path">
          {segments.map((segment, index) => {
            const prefix = prefixes[index]!, crossed = index > 0 && main !== undefined && sources.get(prefix) !== undefined && sources.get(prefix) !== sources.get(prefixes[index - 1]!);
            return (
              <Fragment key={prefix}>
                {index > 0 && <span className="scope-slash" aria-hidden="true">/</span>}
                <button type="button" className={`scope-segment${index === segments.length - 1 ? ' now' : ''}${crossed ? ' crossed' : ''}`} disabled={main === undefined || !sources.has(prefix)} onClick={() => props.onPick(prefix)}>{segment}</button>
              </Fragment>
            );
          })}
        </span>
        <span className="scope-where">{where}</span>
      </div>
    </div>
  );
}
