/**
 * 排布一块（模板设计页第三轮票据 03，方案「检查器」、原型 02）：方向四个图标、堆叠时的九宫格对齐、间距与内边距一行。
 * 点了之后 `layout` 整项写什么在 template/layout.ts；写回走字段环境的 onWrite，所以子元素认不得的 `place` 键照现有规则清掉，
 * 选了状态取值时落进这个取值的覆盖。循环的每项方向用同样的图标按钮（FlowButtons）。
 */
import { FLOW_COLUMN, FLOW_FREE, FLOW_GRID, FLOW_ROW, Icon } from '../components/icon.js';
import { FieldRow, FieldRows, type FieldContext } from '../components/property-fields.js';
import { ALIGNS, alignmentOf, cellLabel, cellOn, FLOW_LABELS, flowOf, SPREAD_LABELS, spreadOf, withCell, withFlow, withSpread, type Align, type Alignment, type Flow, type Spread } from '../template/layout.js';
import { fieldByKey, type PropertyField, type PropertyPanel } from '../template/properties.js';

const FLOWS: readonly { readonly value: Flow; readonly label: string; readonly icon: string }[] = [
  { value: 'free', label: FLOW_LABELS.free, icon: FLOW_FREE },
  { value: 'row', label: FLOW_LABELS.row, icon: FLOW_ROW },
  { value: 'column', label: FLOW_LABELS.column, icon: FLOW_COLUMN },
  { value: 'grid', label: FLOW_LABELS.grid, icon: FLOW_GRID },
];

/** 一排图标按钮，选中的按下；点已经选中的不写。容器与画板是四个，循环的每项方向是横、纵两个。 */
export function FlowButtons<T extends string>(props: { readonly label: string; readonly value: T; readonly options: readonly { readonly value: T; readonly label: string; readonly icon: string }[]; readonly onPick: (value: T) => void }) {
  return (
    <div className="segmented flow-buttons" role="group" aria-label={props.label} data-testid="flow-buttons">
      {props.options.map((option) => (
        <button key={option.value} type="button" aria-label={option.label} title={option.label} aria-pressed={props.value === option.value} data-value={option.value}
          onClick={() => { if (option.value !== props.value) props.onPick(option.value); }}><Icon d={option.icon} /></button>
      ))}
    </div>
  );
}

/** 九宫格：左中右乘上中下。主轴在分空隙（两端、均分）时只管交叉轴，对上的一排（或一列）三格都亮。 */
function AlignGrid(props: { readonly alignment: Alignment; readonly onPick: (horizontal: Align, vertical: Align) => void }) {
  const { alignment } = props, spread = spreadOf(alignment);
  const only = spread ? `${SPREAD_LABELS[spread]}时这里只管${alignment.direction === 'row' ? '上中下' : '左中右'}` : undefined;
  return (
    <div className="align-grid" role="group" aria-label="对齐" data-testid="align-grid" title={only}>
      {ALIGNS.flatMap((vertical) => ALIGNS.map((horizontal) => (
        <button key={`${horizontal}-${vertical}`} type="button" className="align-cell" data-testid="align-cell" aria-label={cellLabel(horizontal, vertical)} title={only ?? cellLabel(horizontal, vertical)}
          aria-pressed={cellOn(alignment, horizontal, vertical)} onClick={() => props.onPick(horizontal, vertical)}><i /></button>
      )))}
    </div>
  );
}

export function LayoutSection(props: { readonly panel: PropertyPanel; readonly fields: readonly PropertyField[]; readonly context: FieldContext; readonly childCount: number }) {
  const { panel, fields, context } = props;
  const field = fields.find((item) => item.key === 'layout')!, padding = fields.find((item) => item.key === 'padding');
  const layout = field.value, flow = flowOf(layout), alignment = alignmentOf(layout), spread = spreadOf(alignment);
  const inner = (key: string) => fieldByKey(panel, `layout.${key}`);
  const write = (next: unknown) => context.onWrite(field.path, next, { now: true });
  const overridden = context.binding?.overriddenBy(field) ?? [];
  const resettable = context.stateValue !== undefined && context.resetOverride && overridden.includes(context.stateValue);
  const rest = fields.filter((item) => item.key !== 'layout' && item.key !== 'padding');
  const half = (item: PropertyField | undefined) => item && <FieldRow key={item.key} field={item} context={context} half />;
  const stacked = flow === 'row' || flow === 'column', wrap = inner('wrap'), crossGap = inner('crossGap');
  return (
    <>
      <div className="layout-head" data-testid="property-field" data-key="layout" data-flow={flow}>
        {overridden.length > 0 && <i className="prop-state-dot" data-testid="state-dot" title={`状态样式在 ${overridden.join('、')} 时覆盖这一项`} aria-label={`状态样式在 ${overridden.join('、')} 时覆盖这一项`} />}
        <FlowButtons label="排布方式" value={flow} options={FLOWS} onPick={(next) => write(withFlow(layout, next, props.childCount))} />
        {alignment && (
          <div className="layout-align">
            <select className="layout-spread" aria-label="主轴分布" title="主轴上怎么分空隙：挨着排、两端、均分" value={spread ?? ''} onChange={(event) => write(withSpread(layout, (event.target.value || undefined) as Spread | undefined))}>
              <option value="">挨着排</option>
              {(Object.keys(SPREAD_LABELS) as Spread[]).map((value) => <option key={value} value={value}>{SPREAD_LABELS[value]}</option>)}
            </select>
            <AlignGrid alignment={alignment} onPick={(horizontal, vertical) => { if (!cellOn(alignment, horizontal, vertical) || spread) write(withCell(layout, horizontal, vertical)); }} />
          </div>
        )}
      </div>
      {resettable && <button type="button" className="link small prop-reset" data-testid="state-reset" onClick={() => context.resetOverride!(field)}>重置为自身属性</button>}
      {stacked && (
        <>
          <div className="prop-pair" data-testid="prop-pair">{half(inner('gap'))}{half(padding)}</div>
          {wrap && <FieldRow field={wrap} context={context} />}
          {crossGap && (wrap?.value === true || crossGap.value !== undefined) && <FieldRow field={crossGap} context={context} />}
        </>
      )}
      {flow === 'grid' && (
        <>
          <FieldRows fields={[inner('rows'), inner('columns')].filter((item): item is PropertyField => Boolean(item))} context={context} />
          <div className="prop-pair" data-testid="prop-pair">{half(inner('rowGap'))}{half(inner('columnGap'))}</div>
          {padding && <FieldRow field={padding} context={context} />}
        </>
      )}
      {flow === 'free' && padding && <FieldRow field={padding} context={context} />}
      <FieldRows fields={rest} context={context} />
    </>
  );
}
