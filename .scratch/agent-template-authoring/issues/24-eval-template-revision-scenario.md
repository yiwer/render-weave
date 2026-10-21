# 24: 评估加一个模板辅助修改场景

**What to build:** `scripts/agent-eval/run.ts` 多一个 `m402-revision` 场景：从首测模板出发，按 M215 的两条修改要求做一轮模板辅助修改，按版面检查、压测与修改范围评分。模板辅助修改从此有自动回归，票据 17 的效果也量得出来。

**Blocked by:** 21

**Status:** resolved

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

- [x] `scenarios.ts` 有 `RevisionScenario`，`config.json` 有 `m402-revision` 与通过线。
- [x] 离线用例：用 `first-test` 当成果时不达线（版面 0/2）；只交回 `t07-round2` 的站点格与道路段、其余保留 `first-test` 时达线（压测 7/10、版面 2/2、范围违例 0）；完整 `t07-round2` 因改了主模板而不达线；只改了"时刻项"的成果报修改范围违例。
- [x] `docs/agent-eval.md` 的场景表、通过线与"必须跑"的说明更新。
- [x] 真跑两次，报告存档：记下 Haiku 5.5 的成绩、用时与 token，作为票据 17 的对照基线。
- [x] `test/agent-eval.test.ts` 离线用例通过；不调用模型、不读 key。

**测试接缝：** `test/agent-eval.test.ts` 的假 launcher、`scoreScenario` 与 `judge`；修改范围的评分直接调 `revisionDiff`。

**不在本票：** 价签修改场景（`scripts/agent-eval/scenarios/price-tag/requirement-revision.md` 的修改前模板没有入库，要先冻结一份）；`check_outcome` 返回差异（票据 17）。

## Answer

2026-10-20 完成（M292）。实现提交 `18768f8`；真实评估从该干净提交发起，未改 Agent 资料或 MCP 合同。

**成果**

- `RevisionScenario` 配置固定的首测模板、修改要求与允许改动的模板；`cliLauncher` 透传 `--requirement`，经产品路径只跑一轮模板辅助修改。
- 成果按名称覆盖已保存模板，未交回的保留原样；完整合并集复用版面与压测评分。`revisionDiff` 经引擎公开入口导出，逐个比较已保存模板，报告模板状态、范围违例与改动元素路径数。
- 通过线不变：合格、版面 2/2、压测至少 6/10、范围违例 0。缺少轮次记录或范围评分不能通过；重新评分不调用模型。
- 文档说明默认四个场景与修改相关变更必须跑新场景；新增场景本次只建立自己的基线。已有三个场景的资料未变，报告资料哈希与 `2026-10-20-contract-060` 完全相同。

**验证**

- TDD：先见正例因场景不存在失败，再接通；再见完整第二轮成果被误判达线，补范围评分使其失败；报告缺范围摘要、丢失轮次记录仍通过也各先复现再修复。
- `npm run typecheck`、`npm run build`：通过。
- `npx vitest run test/agent-eval.test.ts`：21 项通过。新增 4 项覆盖正例、原样交回、主模板越界、时刻项越界，以及缺失评分/轮次记录、重新评分、连续两次达线与报告。使用假执行器和随机测试 key，不调用模型、不读真实 key。
- `npm test`：47 个文件、955 项全部通过。
- 两轴审查（`52f4d1b...18768f8`）：Standards 0 项、Spec 0 项；未发现需修复的问题。
- 真实评估命令：`npx tsx scripts/agent-eval/run.ts --scenarios m402-revision --repeat 2 --jobs 2 --label 2026-10-20-ticket24-revision`，退出码 0。Windows 发起前把 npm 全局安装中的 `@anthropic-ai/claude-code/bin` 加入本进程 PATH，原生版本 2.1.296。
- 报告：[2026-10-20-ticket24-revision.json](../../../docs/agent-eval/reports/2026-10-20-ticket24-revision.json)；轮次：`out/agent-eval/2026-10-20-ticket24-revision/run-{1,2}/m402-revision/revision/`。
- `npx tsx scripts/agent-eval/run.ts --rescore out/agent-eval/2026-10-20-ticket24-revision`：退出码 0，重新评分前后报告 SHA-256 完全相同。
- `node scripts/scan-keys.mjs out/agent-eval/2026-10-20-ticket24-revision docs src scripts test .scratch/agent-template-authoring/issues/24-eval-template-revision-scenario.md CONTEXT.md`：454 个文件、1 个 key、命中 0；`git diff --check` 通过。

| 次数 | 合格 / 压测 / 版面 / 范围违例 | 改动元素 | 用时 | 输入 / 输出 token | 思考 token |
|---|---|---:|---:|---:|---:|
| 1 | 合格 / 7/10 / 2/2 / 0 | 8 | 174.741 秒 | 34 / 28,592 | 13,579 |
| 2 | 合格 / 7/10 / 2/2 / 0 | 9 | 137.574 秒 | 40 / 20,005 | 8,362 |

两次都是 Haiku 5.5、缺省推理力度、合同 0.6.0；只改站点格和道路段，无待确认项、工具错误、转存或重试。合计 5.2 分钟（各轮之和）、输出 48,597 tokens、读缓存 1,788,853 tokens。地标底线差均为 0 mm，道路名同间隔分布，相似度均为 0.9141。剩下 3 个压测失败（本站 0、两种 1500 mm 宽场景）是首测主模板原有的问题，在本轮允许范围之外。该报告是票据 17 的改前基线。

**偏差与后续判断**

- 正例按实施前核验修正：完整 `t07-round2` 含主模板改动，范围违例 1；只取两个允许模板的正例才符合单轮要求。未放宽范围或通过线。
- 范围按已保存模板判断，允许模板中的额外属性变化不算越界；新增模板沿用产品校验，不计入已保存模板范围检查。改动元素数含画板、不含模板层参数/派生变量/检查项，只作参考。
- 带反馈的下一轮值得另做：当前场景只验证首次修改，不能观察 Agent 是否读懂并落实后续意见。应单独冻结首轮成果、反馈及新的允许范围，再验证反馈后的版面/压测改善和无关模板不变；不把本票改成两轮，以保留票据 17 的单轮对照基线。

## Comments

- 2026-10-20 实施前核验并经用户确认：原正例与修改范围规则矛盾。`t07-round2` 包含第二轮对主模板的压测修复，不能整份作为本票正例；改用其中站点格、道路段两个工作副本，已离线验证合格、压测 7/10、版面 2/2、范围违例 0。通过线保持不变。
- 2026-10-19 二次复核新开。排在 21 之后：新场景一单元要跑十分钟上下，跑之前评估要能区分上游故障。
