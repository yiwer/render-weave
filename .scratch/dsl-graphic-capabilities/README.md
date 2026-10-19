# DSL 1.x 平面设计能力演进票据（P1 / P2）

本页只维护索引：标题、直接阻塞与验收映射。状态以各票据的 `**Status:**` 行为准，验收记录写在各票据的 `## Answer`。

父规格：[DSL 1.x 平面设计能力演进（P1 / P2）](spec.md)。

| 票据 | 完整行为 | 直接阻塞 | 规格验收 |
|---|---|---|---|
| 01 | [派生变量支持乘除取模、按分隔符拆取文本与复合条件](issues/01-derived-operations-and-conditions.md) | 无 | A01、A02、A03 |
| 02 | [循环容器支持反序、区间切片与纵向合并相邻同值项](issues/02-loop-slice-reverse-and-column-merge.md) | 无 | A01、A02、A04 |
| 03 | [堆叠布局与循环容器支持自动流式换行 `wrap`](issues/03-stack-and-loop-wrap.md) | 02 | A01、A02、A04 |
| 04 | [矢量图形（路径、多边形、线条）支持 `viewBox` 随元素框缩放](issues/04-shape-viewbox-scaling.md) | 无 | A01、A02、A05 |
| 05 | [文本支持固定字间距 `letterSpacing` 与横排收紧字距适配](issues/05-text-letter-spacing-and-tighten.md) | 无 | A01、A02、A06 |
| 06 | [竖排文本支持文本片段独立字体字号与竖排标点旋转](issues/06-vertical-text-fragments-and-punctuation.md) | 05 | A01、A02、A06 |
| 07 | [图片元素支持 `tint` 单色重染](issues/07-image-tint.md) | 无 | A01、A02、A07 |

- `01`、`02`、`04`、`05`、`07` 无前置阻塞，可并行领取。
- 单票完成时跑 `npm test`（含 `test/dsl-template-schema.test.ts` 的双端参考关键词与示例出图检查）；整批改动了 `agent/reference/template.md` 的票据收尾时，按 A08 统一复跑一次 Agent 评估门槛并扫描 key。
- 按阻塞关系领取票据：直接阻塞票全部 `resolved` 后才能开始。
