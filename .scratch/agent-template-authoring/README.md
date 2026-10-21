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
| 10 | [Agent 交回前用只读工具核对成果](issues/10-check-outcome-before-handoff.md) | 07、08 | A04、A10（验收后的后续，来自 Spec 审查第 1 项） |
| 11 | [Agent 用 view_image 查看资源仓库中的图片](issues/11-view-resource-images.md) | 10 | A04、A10（验收后的后续，来自 Spec 审查第 2 项） |
| 12 | [循环容器可以纵向排列列表项](issues/12-vertical-loop.md) | 无 | A01、A02、A03、A10（验收后的后续，来自真人走查） |
| 13 | [网格的比例列、跨行列元素与超出单元格不再静默重叠](issues/13-grid-overlap.md) | 无 | A01、A02、A03（验收后的后续，来自与 design-layout-draw 网格的对照） |
| 14 | [模板声明自己的缩字下限，小尺寸标签可以缩到 5 mm 以下](issues/14-template-min-font-size.md) | 无 | A01、A02、A03、A10（验收后的后续，来自 Spec 审查第 3 项） |
| 15 | [还不是版本仓库的目录提示先 resources-init](issues/15-uninitialized-resource-store.md) | 无 | A01（验收后的后续，第二阶段遗留） |
| 16 | [`agent run` 精确校验任务需要的参数](issues/16-agent-run-task-options.md) | 无 | 2026-10-19 外围工具复核 P1-1 |
| 17 | [`check_outcome` 返回模板修改的结构化差异](issues/17-check-outcome-revision.md) | 24 | 2026-10-19 外围工具复核 P1-2（二次复核降为 P2） |
| 18 | [模板设计的主模板基准必须等于数据集选定的数据定义](issues/18-template-base-matches-dataset.md) | 无 | 2026-10-19 外围工具复核 P2-3（二次复核改写，P3） |
| 19 | [`view_image` 缺省不再把小区域放大到 1400 像素](issues/19-view-image-multiple-regions.md) | 无 | 2026-10-19 外围工具复核 P2-4（二次复核改写） |
| 20 | [修正模板参考里的数据定义示例指向](issues/20-template-reference-data-definition-pointer.md) | 无 | 2026-10-19 外围工具复核 P2-5（二次复核降为 P3） |
| 21 | [评估把上游瞬时错误与模型失败分开](issues/21-eval-retry-transient-errors.md) | 无 | 2026-10-19 外围工具复核 P2-6（二次复核改写） |
| 22 | [MCP 工具的文字结果不超过 Claude Code 的落盘阈值](issues/22-mcp-output-within-client-limits.md) | 无 | 2026-10-19 二次复核新发现 1 |
| 23 | [业务 Agent 的思考预算可设置、有记录，并用评估定缺省](issues/23-agent-thinking-budget.md) | 21 | 2026-10-19 二次复核新发现 2 |
| 24 | [评估加一个模板辅助修改场景](issues/24-eval-template-revision-scenario.md) | 21 | 2026-10-19 二次复核新发现 3 |
| 25 | [Gemini 的长调用不再在约 300 秒处失败](issues/25-gemini-proxy-streaming.md) | 无 | 2026-10-20 阿拉伯文站牌实跑 |
| 26 | [需要塑形或从右往左的文字，出图时报问题而不是静默画错](issues/26-unshaped-script-problem.md) | 无 | 2026-10-20 阿拉伯文站牌试跑 |
| 27 | [Agent 资料补齐必填判断、领域约定的适用条件与模板的分段写法](issues/27-materials-schema-judgement-and-incremental-templates.md) | 26、29 | 2026-10-20 阿拉伯文站牌试跑；A10 |
| 28 | [`agent run` 先校验出图请求再开始，用满轮数时不打印空的报错](issues/28-agent-run-request-and-error-messages.md) | 无 | 2026-10-20 阿拉伯文站牌试跑 |
| 29 | [`list_resources` 给出字体的字重与覆盖的文字](issues/29-list-resources-font-coverage.md) | 无 | 2026-10-20 阿拉伯文站牌试跑；A04 |

已检查：35 条用户故事全部覆盖；A01–A12 全覆盖；依赖编号有效、无环、无冗余的传递边。16–21 来自 2026-10-19 的[外围工具复核](../../docs/agent-tooling-review.md)，22–24 来自同日的[二次复核](../../docs/agent-tooling-evaluation.md)，25–29 来自 2026-10-20 实跑一张阿拉伯文站牌，都不改变上面的验收映射。

- 01、03 可以并行开始。
- 03 的 DSL 参考工具返回 `agent/reference/` 与 `schemas/` 中的现有内容，01、02 完成后内容自然更新，所以 03 不依赖 01、02。
- 06 起，数据集与模板候选使用 01、02 的 Schema 做前置校验。06 不直接列 01，是因为 01 未完成时，候选仍可只经引擎校验；Schema 前置校验在 01、02 完成后接入，09 汇总时核对。

按阻塞关系领取票据：直接阻塞票全部 resolved 后才能开始。
