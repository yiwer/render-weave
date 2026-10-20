# 18: 模板设计的主模板基准必须等于数据集选定的数据定义

**What to build:** 模板辅助设计的 `check_outcome`、交回后的成果校验与审核/应用时的复查，在出图请求的主模板的 `base` 与本轮数据集选定的 `staticSchema` 不一致时报不合格；被调模板不比较。

**Blocked by:** 无

**Status:** ready-for-agent

**Trace:** M43（任务顺序与基准）、M49（模板工作副本）、ADR-0007（子模板沿数据定义引用组合，作用域不继承）；2026-10-19 [外围工具复核](../../../docs/agent-tooling-review.md) P2-3，[二次复核](../../../docs/agent-tooling-evaluation.md#票据-18) 改为 P3 并改写判据；验收 A09。

背景：

- `checkTemplates` 只检查模板的 `base` "存在且可编译"（`src/agent/candidates.ts:146-150`），不比较主模板的基准是否等于本轮数据集的 `staticSchema`。
- `CandidateContext` 只有 `definition`（数据集提取用）与 `revision`（`src/agent/candidates.ts:25-30`）；上下文在两处分别构造：
  - `agent run`：`src/agent/run.ts:310-314`，交给交回后的成果校验与 `check_outcome`；
  - 审核与应用：`src/agent/review.ts:659-660`，交给审核视图（`src/agent/review.ts:809-810`）与应用前的复查（`src/agent/review.ts:528`）。
- 实际出图时 `src/preflight.ts:35-39` 报 `datasetStaticSchemaMismatch` 并 blocked，所以 `render_draft` 会先挡住；但 `check_outcome` 仍说 qualified。
- 影响是推断的：4 次模板评估轮都用出图请求的数据集出了草稿（`out/agent-eval/*/run-*/m402-template/template/logs/tools.jsonl`），这个缺口没有实际发生过。

**决定**：

- **只比较主模板**：出图请求的主模板（`context.request.template`）的 `base` 必须等于数据集选定的 `staticSchema`。
  - 被调模板不比较：它们以数据定义引用的那份定义为基准，本来就不同。M402 的专家模板里，主模板基准是"线路牌 v1"，被调模板是"停靠站点 v1""单值·时刻 v1""单值·文本 v1"（`docs/examples/m402-dsl/template-*.json` 第 4 行）；提示词也只要求主模板的基准是 `{definition}`（`agent/tasks/template-design.md:14`）。
  - 原写法"对新建模板比较"会把所有带被调模板的成果判成不合格：模板辅助设计的候选全是新建模板。
- **上下文只在一处构造**：新增一个从轮次记录得出 `CandidateContext` 的函数，`run.ts` 与 `review.ts` 都调它；模板辅助设计时带上 `definition`（数据集选定的那份）与主模板名。否则审核与应用的复查与 `check_outcome` 判据不一致。
- 不一致时报 severe，位置写 `${主模板候选路径}#base`，说明写出两边的"名称 v版本"。
- 模板辅助修改不比较：base 的改动由 `revisionDiff` 呈现给审核人。
- 合同：输出结构不变，只是多一种问题；与票据 17、22 同批发，只跑一次评估。

- [ ] 主模板基准与数据集定义不一致时，`check_outcome`、`check.json` 与审核视图的结论都是 `unqualified`，问题指向主模板候选的 `#base`。
- [ ] 被调模板的基准与主模板不同时（M402 的组合），结论不变。
- [ ] 基准一致时结论不变；模板辅助修改不受影响。
- [ ] `run.ts` 与 `review.ts` 用同一个函数得出上下文；`render_draft` 原有的 `datasetStaticSchemaMismatch` 保持不变。
- [ ] 回归用例加在 `test/agent-dataset-template.test.ts`；全量 `npm test` 通过。

**测试接缝：** `checkAgentOutcome` 与审核视图的读取（`readReview`）；用 `test/agent-dataset-template.test.ts` 现有的模板/数据集 fixture，另加一份被调模板基准不同的组合。

**不在本票：**

- 渲染前的 `datasetStaticSchemaMismatch` 检查，它已经在 `preflight.ts` 里。
- 让 `check_outcome` 对模板任务按出图请求出一次草稿、把 blocked 计入结论：覆盖面比只比 base 大，但改变 M48"成果校验 = 结构 + 引擎静态校验"的口径，要先拍板。

## Comments

- 2026-10-19 二次复核：原判据会误伤被调模板，已按上文改写；优先级由 P2 降为 P3（缺口在评估中没有发生过，草稿预览已经挡住）。
