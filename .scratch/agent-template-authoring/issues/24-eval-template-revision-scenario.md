# 24: 评估加一个模板辅助修改场景

**What to build:** `scripts/agent-eval/run.ts` 多一个 `m402-revision` 场景：从首测模板出发，按 M215 的两条修改要求做一轮模板辅助修改，按版面检查、压测与修改范围评分。模板辅助修改从此有自动回归，票据 17 的效果也量得出来。

**Blocked by:** 21

**Status:** ready-for-agent

**Trace:** M49–M51（工作副本、调用树与结构化差异）、M215（模板辅助修改实测）、M230（评估门槛）；2026-10-19 [外围工具复核](../../../docs/agent-tooling-review.md)「未决」第 1 条，[二次复核](../../../docs/agent-tooling-evaluation.md#新发现-3模板辅助修改与下一轮没有自动评估)；验收 A09、A10。

背景：

- 评估只有数据定义、模板辅助设计与转录三类场景（`scripts/agent-eval/scenarios.ts:17-41`），模板辅助修改与带反馈的下一轮都只靠手工验收。v1.0 的代建主要是"做模板、再按客户意见改"，修改是主路径之一。
- 素材都在库里，而且已经校准过：
  - 修改前：`fixtures/agent-eval/templates/first-test/`，主模板"线路牌主模板"，压测 6/10、两项版面检查都不过（地标底线差 −12 mm，道路名两端分布）；
  - 修改要求：`scripts/agent-eval/scenarios/m402/requirement-m215.md`，正好针对这两项，写了元素路径 `站点格/站名框/地标` 与 `道路段/道路名`；
  - 修改后的参照：`fixtures/agent-eval/templates/t07-round2/`（修改两轮之后），压测 10/10、版面 2/2；
  - 两份的评分断言已在 `test/agent-eval.test.ts:79-88`。
- 当年这一轮（M215 复现）：合格、只改了站点格与道路段，道路段多改了一处宽度上限并在说明里写明（`docs/agent-validation.md:466-479`）。

**决定**：

- 场景 `m402-revision`（`kind: 'revision'`）：
  - 工作区：`docs/examples/m402-dsl` 的两份数据定义、编译产物与 `dataset-m402.json`，加上 `first-test` 的 5 个模板作为已保存模板；
  - 输入：`--task 模板辅助修改`，示例图、`brief-template.md`、`route-sign` 领域、`scripts/agent-eval/scenarios/m402/request-template.json`、`requirement-m215.md`；
  - 只跑一轮，不带反馈。
- 评分：
  - 把成果中的工作副本叠加在已保存模板上，复用 `scoreTemplates`；
  - **修改范围**：用 `revisionDiff` 比较每个已保存模板，修改要求点名的模板（站点格、道路段）以外的模板必须 `unchanged`；另报改动元素数，只作参考。
- 通过线：轮次合格；版面检查 2/2；压测不低于修改前的 6/10；修改范围违例 0。连续两次达线（与其他场景相同）。
- 带反馈的下一轮先不做：要模拟审核意见，评分口径要另定；在本票 `## Answer` 里写清楚是否值得做。

- [ ] `scenarios.ts` 有 `RevisionScenario`，`config.json` 有 `m402-revision` 与通过线。
- [ ] 离线用例：用 `first-test` 当成果时不达线（版面 0/2）；只交回 `t07-round2` 的站点格与道路段、其余保留 `first-test` 时达线（压测 7/10、版面 2/2、范围违例 0）；完整 `t07-round2` 因改了主模板而不达线；只改了"时刻项"的成果报修改范围违例。
- [ ] `docs/agent-eval.md` 的场景表、通过线与"必须跑"的说明更新。
- [ ] 真跑两次，报告存档：记下 Haiku 5.5 的成绩、用时与 token，作为票据 17 的对照基线。
- [ ] `test/agent-eval.test.ts` 离线用例通过；不调用模型、不读 key。

**测试接缝：** `test/agent-eval.test.ts` 的假 launcher、`scoreScenario` 与 `judge`；修改范围的评分直接调 `revisionDiff`。

**不在本票：** 价签修改场景（`scripts/agent-eval/scenarios/price-tag/requirement-revision.md` 的修改前模板没有入库，要先冻结一份）；`check_outcome` 返回差异（票据 17）。

## Comments

- 2026-10-20 实施前核验并经用户确认：原正例与修改范围规则矛盾。`t07-round2` 包含第二轮对主模板的压测修复，不能整份作为本票正例；改用其中站点格、道路段两个工作副本，已离线验证合格、压测 7/10、版面 2/2、范围违例 0。通过线保持不变。
- 2026-10-19 二次复核新开。排在 21 之后：新场景一单元要跑十分钟上下，跑之前评估要能区分上游故障。
