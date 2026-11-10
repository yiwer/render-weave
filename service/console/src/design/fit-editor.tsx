/**
 * 适配编辑器（模板设计页票据 10，方案第 7 节）：步骤只给 DSL 合法的组合，横排竖排由 Schema 的 if/then 分开；用不上的项不藏，写明要什么才生效。
 * 最后一行是这一处实例的结果，来自布局摘要。
 * 平时收成一行摘要（第三轮票据 04）：规则一句、这一处的结果一句，点开才是编辑器；收起展开只是页面上的状态，不写回。
 */
import { useState } from 'react';
import { CHEVRON, CHEVRON_RIGHT, Icon } from '../components/icon.js';
import { FieldRow, type FieldContext } from '../components/property-fields.js';
import { isObject, type JsonObject } from '../template/document.js';
import { fitDigest, fitLine } from '../template/fit.js';
import { fieldByKey, type PropertyPanel } from '../template/properties.js';
import type { LayoutNode } from '../types.js';
import { fitResult } from './overlays.js';

function Off(props: { readonly label: string; readonly reason: string; readonly testid?: string }) {
  return (
    <div className="prop" data-testid={props.testid ?? 'fit-off'}>
      <span className="prop-label">{props.label}</span>
      <span className="small faint">{props.reason}</span>
    </div>
  );
}

interface FitProps {
  readonly panel: PropertyPanel; readonly element: JsonObject; readonly context: FieldContext; readonly boardMinimum: number; readonly members: readonly string[]; readonly vertical: boolean; readonly instance?: LayoutNode | undefined;
}

/** 适配这一组：一行摘要，点开是下面的编辑器。 */
export function FitSection(props: FitProps) {
  const [open, setOpen] = useState(false);
  const digest = fitDigest(props.element['fit'], props.instance?.text);
  return (
    <>
      <button type="button" className={`fit-summary${digest.over ? ' over' : ''}`} data-testid="fit-summary" aria-expanded={open} aria-label={fitLine(digest)} title={open ? '收起' : '点开改适配'} onClick={() => setOpen(!open)}>
        <span className="fit-summary-text">
          <span data-testid="fit-rule">{digest.rule}</span>
          {digest.result && <span className="fit-here" data-testid="fit-here">{digest.result}</span>}
        </span>
        <Icon d={open ? CHEVRON : CHEVRON_RIGHT} />
      </button>
      {open && <FitEditor {...props} />}
    </>
  );
}

export function FitEditor(props: FitProps) {
  const { panel, element, context, boardMinimum, members, vertical, instance } = props;
  const fit = isObject(element['fit']) ? element['fit'] : {};
  const steps = Array.isArray(fit['steps']) ? fit['steps'] as unknown[] : [];
  const row = (key: string, fallback?: unknown) => {
    const field = fieldByKey(panel, key);
    return field ? <FieldRow key={key} field={fallback === undefined ? field : { ...field, fallback }} context={context} /> : null;
  };
  const group = isObject(fit['widthOverflow']) ? fit['widthOverflow']['shrinkGroup'] : undefined;
  return (
    <>
      <p className="small faint" data-testid="fit-mode">{vertical ? '竖排：先收紧字距，字距收到 0 才压缩字形；缩字走缩字组。' : '横排：先收紧字距，再压缩字形，最后同比缩字。'}</p>
      {row('fit.steps')}
      {steps.includes('compressGlyphs') ? row('fit.compressMin') : <Off label="字形压缩下限" reason="步骤里有压缩字形才生效" />}
      {!vertical && (steps.includes('shrink') ? row('fit.minFontSize', boardMinimum) : <Off label="缩字下限（mm）" reason="步骤里有缩字才能写" testid="fit-off-shrink" />)}
      {row('fit.onFail')}
      {vertical ? row('fit.widthOverflow') : <Off label="缩字组" reason="缩字组只用于竖排" testid="fit-off-group" />}
      {typeof group === 'string' && members.length > 0 && <p className="small" data-testid="shrink-group">缩字组 {group}：{members.join('、')}，共 {members.length} 个成员，放不下时一起缩到同一字号。</p>}
      <p className="hint" data-testid="fit-hint">压缩下限缺省 0.6；缩字下限缺省取画板的 {boardMinimum} mm，不能低于它。</p>
      {instance?.text && <p className={`fit-result small${instance.text.overflow ? ' over' : ''}`} data-testid="fit-result">这一处：{fitResult(instance.text)}</p>}
    </>
  );
}
