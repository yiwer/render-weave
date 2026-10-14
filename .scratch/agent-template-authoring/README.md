# 第三阶段实施票据：Agent 代建模板的本地闭环

本页只维护索引：标题、直接阻塞与验收映射。状态以各票据的 `**Status:**` 行为准，验收记录写在各票据的 `## Answer`。

父规格：[第三阶段 PRD](spec.md)。

拆分沿用 tracer bullet：每张票同时交付用户可见行为、公开入口或 CLI、必要的合同与验收。不先做所有合同再做所有界面。

| 票据 | 完整行为 | 直接阻塞 | PRD 验收 |
|---|---|---|---|
| 01 | [数据定义与数据集有 DSL 1.0 参考、Schema 与兼容承诺](issues/01-dsl-schema-and-dataset.md) | 无 | A01、A02、A03 |
| 02 | [模板、渲染请求与批次请求有 DSL 1.0 参考与 Schema](issues/02-dsl-template-and-requests.md) | 01 | A01、A02、A03 |
| 03 | [Agent 经 renderweave mcp 使用只读工具](issues/03-readonly-mcp-tools.md) | 无 | A04 |
| 04 | [一条命令发起数据定义提取，拿到可校验的成果](issues/04-definition-extraction-round.md) | 03 | A05、A06 |
| 05 | [审核数据定义候选并发布为静态数据定义](issues/05-review-and-publish-definition.md) | 04 | A07、A08 |
| 06 | [数据集提取与模板辅助设计经审核写入工作区](issues/06-dataset-and-template-rounds.md) | 05 | A07、A08、A09 |
| 07 | [带反馈的下一轮与模板辅助修改](issues/07-feedback-rounds-and-template-edits.md) | 06 | A09 |
| 08 | [三层资料归档，评估场景成为升级门槛](issues/08-materials-and-eval-gate.md) | 06 | A10 |
| 09 | [新示例图完成端到端代建与阶段验收](issues/09-stage3-acceptance.md) | 02、07、08 | A11、A12；汇总 A01–A10 |

已检查：35 条用户故事全部覆盖；A01–A12 全覆盖；依赖编号有效、无环、无冗余的传递边。

- 01、03 可以并行开始。
- 03 的 DSL 参考工具返回 `agent/reference/` 与 `schemas/` 中的现有内容，01、02 完成后内容自然更新，所以 03 不依赖 01、02。
- 06 起，数据集与模板候选使用 01、02 的 Schema 做前置校验。06 不直接列 01，是因为 01 未完成时，候选仍可只经引擎校验；Schema 前置校验在 01、02 完成后接入，09 汇总时核对。

按阻塞关系领取票据：直接阻塞票全部 resolved 后才能开始。
