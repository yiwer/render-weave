# 17: `check_outcome` 返回模板修改的结构化差异

**What to build:** 模板辅助修改的 Agent 在交回前调用 `check_outcome`，能看到候选模板相对已保存模板改了哪些元素/属性，以及 `unchanged`/`modified`/`added` 状态；不用自己 `read_document` 对比。

**Blocked by:** 24

**Status:** resolved

**Trace:** M233（`check_outcome`）、M49/M51（模板工作副本与结构化差异）；2026-10-19 [外围工具复核](../../../docs/agent-tooling-review.md) P1-2；验收 A09。

背景：

- `checkAgentOutcome` 已经算出 `RevisionDiff`（`src/agent/outcome.ts:250-256`，`src/agent/diff.ts:128-133`）。
- 审核视图把同一份差异和修改要求并排展示（`src/agent/review.ts:871`、`src/agent/review.ts:882`），审核人按“只改要求涉及的地方”判断。
- `check_outcome` 在 `src/mcp/tools.ts:372` 明确剥掉 `revision`，Agent 在交回前看不到任何差异；prompt 也没要求它自己对比。

**决定**：

- `check_outcome` 的每个候选增加 `revision: { status, changes: [...] }`，只在上下文有 `revision` 时出现（模板辅助修改）。
- `changes` 只返回范围：`path`、`target`（`element`/`template`）、`change`（`added`/`removed`/`changed`）、`properties` 的键名；默认不带 `before`/`after`，避免大段内容占上下文。
- `status` 为 `unchanged` 时也返回，让 Agent 知道“这一轮什么都没改”。
- description 与 `docs/mcp.md` 的「交回前核对」同步；改变输出结构，合同从已发布的 0.6.0 升到 0.7.0，复跑评估。
- 不在本票给 `check_templates` 加 `revision`（可选后续，另开票）。
- `changes` 最多返回 100 条，超出时给 `truncated: true` 与总数：大改动（例如重排 30 个元素）时整份输出仍要远低于 Claude Code 的 50,000 字符落盘阈值（票据 22）。
- 票据 22 已随 0.6.0 发布，本票单独发 0.7.0；评估跑全部四个场景，包含票据 24 的模板辅助修改场景，否则其他三个场景都不经过模板辅助修改，看不到本票的效果。

- [x] 模板辅助修改的 `check_outcome` 返回 `revision`，其他任务不返回。
- [x] `status` 的 `modified`/`unchanged`/`added` 三种状态都有用例。
- [x] `changes` 包含路径与属性键，不含 `before`/`after`（断言序列化结果里没有这两个键）。
- [x] 工具说明与 `docs/mcp.md` 更新，合同版本升 0.7.0。
- [x] `npm test` 通过；按门槛跑评估，含票据 24 的模板辅助修改场景，记录改动范围评分与改前相比的变化。

**测试接缝：** `test/mcp.test.ts` 经 JSON-RPC 调 `check_outcome`；复用现有 M402 站点工作副本与审核测试使用的问候牌模板。

**不在本票：** 模板辅助修改的自动评估场景，在票据 24。

## Answer

2026-10-20 完成（M276）。实现提交 `ec010ef`；实测后的提示词修正 `6dea80a`、`826f422`。合同 0.7.0，Haiku 5.5、Claude Code 2.1.296、缺省推理力度。

**实现与验证**

- MCP 直接投影 `checkAgentOutcome` 已有的 `revision`，不另算差异。只返回状态、路径、改动类型与属性键名；新增、删除元素也不含正文。每候选最多 100 条、约 20,000 字符，截断给 `truncated` 与 `total`；原有 40,000 字符服务层兜底不变。内部校验、完整 `check.json`、审核页与 `check_templates` 不变。
- TDD：先复现三个候选的 `revision` 都缺失，再实现投影；再复现 120 条差异没有截断，补条数及长路径字符预算。JSON-RPC 用例同时覆盖只读、非修改任务没有差异、新增/删除元素不带正文。
- `npx vitest run test/mcp.test.ts -u`：32 项通过，仅更新 `check_outcome` 说明的工具快照，逐项核对 diff；`npx vitest run test/agent-eval.test.ts`：21 项通过。
- `npm run typecheck`、`npm run build`：通过。首次全量发现评估测试仍写死合同 0.6.0，更新预期后 `npm test`：47 个文件、958 项全过。其后只改资料与验收记录，未改变代码。
- 两轴审查：实现阶段 Standards 0、Spec 0；资料修正阶段发现首次写成果被推迟，已恢复为本轮改动首次无新增严重问题时就写。复审后两轴均无剩余问题。
- `node scripts/scan-keys.mjs` 扫描四个 ticket17 轮次目录（含主动中断的批次）以及 `docs src scripts test agent`、本票与 `CONTEXT.md`：923 个文件、1 个 key、命中 0；`git diff --check` 通过。

**真实评估与门槛**

运行前仅给当前进程的 PATH 加入 npm 全局安装中的 `@anthropic-ai/claude-code/bin`。三个完整报告均保留，未删除未达线单元、未降低通过线：

1. `npx tsx scripts/agent-eval/run.ts --repeat 2 --jobs 3 --label 2026-10-20-ticket17-contract-070`，退出码 1，[完整批次报告](../../../docs/agent-eval/reports/2026-10-20-ticket17-contract-070.json)。从干净 `ec010ef` 启动；M402 模板和 366 连续两次达线。修改第 1 次虽收到完整差异仍主动修改主模板的 `idxLow` 与检查提示，范围违例 1，第 2 次范围 0；数据定义第 2 次缺运营说明、班车类型，13/15 未达线。
2. 只修改 `agent/tasks/template-revision.md`：无关的既有问题只记说明，逐项核对差异并撤销无关改动，截断部分读取已保存模板核对；保留 M273 的尽早写成果。`npx tsx scripts/agent-eval/run.ts --scenarios m402-definition,m402-revision --repeat 2 --jobs 2 --label 2026-10-20-ticket17-scope-final`，退出码 1，[修正后报告](../../../docs/agent-eval/reports/2026-10-20-ticket17-scope-final.json)。从干净 `826f422` 启动；修改两次均达线，数据定义 13、14，仍未连续达线。
3. 数据定义输入资料没有改动，单独确认：`npx tsx scripts/agent-eval/run.ts --scenarios m402-definition --repeat 2 --jobs 2 --label 2026-10-20-ticket17-definition`，退出码 0，[定义确认报告](../../../docs/agent-eval/reports/2026-10-20-ticket17-definition.json)。专家字段两次 14/15、约定两次 6/6。报告的 dirty 为 true，仅因为前一份评估报告尚未提交，代码与资料仍为 `826f422`。

按 M230 核对资料哈希：原批次与修正后批次只有修改任务提示词不同，模板设计与 366 不读它；最后定义确认与修正后批次全部资料哈希相同。因此采用如下四场景结果，门槛通过：

| 场景 | 采用报告 | 连续两次的成绩 |
|---|---|---|
| M402 数据定义 | ticket17-definition | 专家字段 14、14；约定 6、6 |
| M402 模板 | ticket17-contract-070 | 压测 10/10、10/10；版面 2/2、2/2；相似度 0.9075、0.9115 |
| M402 模板辅助修改 | ticket17-scope-final | 压测 6/10、6/10；版面 2/2、2/2；范围违例 0、0 |
| 366 转录 | ticket17-contract-070 | 站名 59、59；地标 15/15、15/15；设施 18/18、18/18 |

**与票据 24 改前基线对照**

| 指标 | 改前两次 | 最终两次 |
|---|---|---|
| 修改范围违例 | 0、0 | 0、0 |
| 改动元素数 | 8、9 | 7、7 |
| 版面 / 相似度 | 2/2、2/2 / 0.9141、0.9141 | 相同 |
| 压测 | 7/10、7/10 | 6/10、6/10 |
| 用时（秒） | 174.741、137.574 | 157.947、127.702 |
| 输出 token | 28,592、20,005 | 23,093、19,415 |
| 思考 token | 13,579、8,362 | 10,232、10,034 |

最终两次都只改站点格、道路段，主模板原样；没有待确认项、工具错误、结果转存或重试。两次 `check_outcome` 文字结果均为 887 字符，差异未截断。压测减少的 1 项是“2 站同路”：新结果保留道路段原来的 400 mm 宽度上限，不再顺手扩到 1500 mm；通过线仍为至少 6/10，历史问题如实记入说明。改前范围已经是 0，不能据此宣称范围评分提升；证据支持更少的附带改动与相同版面结果，样本不足以证明稳定性整体提升。

**偏差与限制**

- 原计划随票据 22 发 0.6.0 已过时，本票单独升 0.7.0。增加字符预算防长路径撑大结果。
- 首轮真实评估表明“展示差异”不等于 Agent 会守住范围，因此补了修改提示词；没有扩大自动校验职责，是否满足修改要求仍由审核人判断。
- 数据定义的 6 次有效样本为 14、13、13、14、14、14；末两次达线，但既有边界波动仍在，未调整提取资料或评分。本票不宣称解决这一稳定性问题。
- 曾启动 `2026-10-20-ticket17-scope`，追加审查发现首次写成果时机回退后主动停止；当时只有未完成的数据定义轮，修改轮尚未启动。原始目录保留，不算有效评估，也不生成通过报告。随后用最终资料另启 `scope-final`，避免混用提示词。
- 所有轮次在 `out/agent-eval/2026-10-20-ticket17-*/`；完整报告的工具结果转存均为 0，没有上游错误、额度中断或自动重试。原批次模板第 1 次有一次把内置定义当成工作区文档读取的工具错误，Agent 随后继续并达线。

## Comments

- 2026-10-20 实测补充：0.7.0 首轮评估的第 1 次修改拿到了完整差异摘要，仍主动修改主模板的本站序号检查，说明中承认超出要求；第 2 次未越界。仅展示差异不足以保证 Agent 撤销无关改动。补清修改任务提示词的结束条件：极端验证发现无关既有问题只记录，本轮不扩大范围；交回前逐项核对 `revision` 并撤销无关改动，截断部分读已保存模板核对。只重跑受影响的修改场景；数据定义另因既有的 13/15 边界波动补跑。原始失败报告保留。
- 2026-10-19 二次复核（[实测记录](../../../docs/agent-tooling-evaluation.md#票据-17)）：由 P1 降为 P2，排在票据 24 之后。
  - 不是"假合格"：修改范围本来就不进结论（M48），审核页的改动表照常列出全部差异。
  - 有记录的 3 次模板辅助修改里，只有 M215 那次多改了一处（道路段宽度上限 400 → 1500 mm），是 Agent 有意改的，说明里写明了，审核时接受（`docs/agent-validation.md:479`）；价签与 366 两次都只改了要求涉及的地方（`docs/stage3-acceptance.md:84`、`docs/stage3-acceptance.md:118`）。没有见到"无意中改多"。
  - 本票的价值是防无意改动，要靠修改场景的改动范围评分才量得出来，所以先做 24。
