/**
 * 左面板的"添加"页（模板设计页票据 14，方案第 13 节）：从字段创建。点一下加到选中的容器（选中的不是容器就放在它后面），
 * 或者拖到结构树与舞台上。列表、单引用字段要先选基准相符的模板。写回在 template/create.ts。
 * 元素目录在第三轮票据 06 搬到了底部工具栏（design/insert-bar.tsx）；这一页在票据 07 并进"数据"页之前先留着。
 */
import { useState } from 'react';
import { TYPE_GLYPHS } from '../components/value-text.js';
import { planFromField } from '../template/create.js';
import type { JsonObject } from '../template/document.js';
import { endAddDrag, refText, startAddDrag, TemplateChoice, type InsertSources } from './insert-bar.js';

export function AddPanel(props: {
  readonly template: string; readonly document: JsonObject; readonly sources: InsertSources; readonly targetLabel: string; readonly selectionLabel?: string;
  readonly onAdd: (element: JsonObject) => void; readonly onBindVisible: (variable: string) => void;
}) {
  const { template, document } = props, { base, fields, bindings } = props.sources;
  const [open, setOpen] = useState<string>();
  const [chosen, setChosen] = useState('');
  const reset = (key?: string) => { setOpen(key); setChosen(''); };

  return (
    <div className="add-panel" data-testid="add-panel">
      <p className="small faint">加到 <strong data-testid="add-target">{props.targetLabel}</strong>：选中容器就放进去，选中别的元素就放在它后面。也可以拖到结构树或图上。</p>
      <p className="small faint">文字、图片、形状、容器、循环、调用从底部工具栏加。</p>
      <section aria-label="从字段创建" className="add-section">
        <h3>从字段创建<span className="small faint"> {base ? refText(base) : ''}</span></h3>
        {!base && <p className="small muted">这个模板没有写数据定义。</p>}
        {fields.length === 0 && base && <p className="small muted">{props.sources.loadingFields ? '正在读取字段…' : '读不到字段：内置的单值数据定义只有 value。'}</p>}
        <ul className="add-fields">
          {fields.map((field) => {
            const plan = planFromField(field, document, bindings);
            const element = plan.kind === 'element' ? plan.element : undefined;
            const key = `field:${field.name}`;
            const what = plan.kind === 'element' ? (element?.['type'] === 'image' ? '变图片' : '变文字') : plan.kind === 'visible' ? '绑到选中元素的显示' : plan.kind === 'template' ? (field.type === 'list' ? '变循环容器' : '变子模板调用') : plan.reason;
            return (
              <li key={field.name}>
                <button type="button" className="add-field-row" data-testid="add-field" data-name={field.name} draggable={Boolean(element)} disabled={plan.kind === 'none' || (plan.kind === 'visible' && !props.selectionLabel)}
                  title={plan.kind === 'visible' && !props.selectionLabel ? '先选中一个元素' : field.name} aria-expanded={plan.kind === 'template' ? open === key : undefined}
                  onDragStart={(event) => element && startAddDrag(event, { template, element, fromField: true })} onDragEnd={endAddDrag}
                  onClick={() => {
                    if (plan.kind === 'element') props.onAdd(plan.element);
                    else if (plan.kind === 'visible') props.onBindVisible(plan.variable);
                    else if (plan.kind === 'template') reset(open === key ? undefined : key);
                  }}>
                  <span className="variable-glyph mono" aria-hidden="true">{TYPE_GLYPHS[field.type] ?? '·'}</span>
                  <span className="variable-name">{field.label}</span>
                  <span className="small faint">{plan.kind === 'visible' && props.selectionLabel ? `绑到「${props.selectionLabel}」的显示` : what}</span>
                </button>
                {open === key && plan.kind === 'template' && (
                  <form className="add-form" aria-label={`从 ${field.label} 创建`} onSubmit={(event) => { event.preventDefault(); if (chosen) { props.onAdd(plan.element(chosen)); reset(); } }}>
                    <TemplateChoice base={plan.base} templates={props.sources.templates} self={template} value={chosen} why={field.type === 'list' ? `循环的每一项是「${field.label}」的一项，被调模板的基准就是它。` : `调用传「${field.label}」这份数据，被调模板的基准是它指向的数据定义。`} onChange={setChosen} />
                    <button type="submit" className="small" disabled={!chosen}>{field.type === 'list' ? '添加循环容器' : '添加子模板调用'}</button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
