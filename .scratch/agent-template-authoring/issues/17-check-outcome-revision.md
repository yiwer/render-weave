# 17: `check_outcome` 返回模板修改的结构化差异

**What to build:** 模板辅助修改的 Agent 在交回前调用 `check_outcome`，能看到候选模板相对已保存模板改了哪些元素/属性，以及 `unchanged`/`modified`/`added` 状态；不用自己 `read_document` 对比。

**Blocked by:** 24

**Status:** ready-for-agent

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

- [ ] 模板辅助修改的 `check_outcome` 返回 `revision`，其他任务不返回。
- [ ] `status` 的 `modified`/`unchanged`/`added` 三种状态都有用例。
- [ ] `changes` 包含路径与属性键，不含 `before`/`after`（断言序列化结果里没有这两个键）。
- [ ] 工具说明与 `docs/mcp.md` 更新，合同版本升 0.7.0。
- [ ] `npm test` 通过；按门槛跑评估，含票据 24 的模板辅助修改场景，记录改动范围评分与改前相比的变化。

**测试接缝：** `test/mcp.test.ts` 经 JSON-RPC 调 `check_outcome`；复用现有 M402 站点工作副本与审核测试使用的问候牌模板。

**不在本票：** 模板辅助修改的自动评估场景，在票据 24。

## Comments

- 2026-10-20 实测补充：0.7.0 首轮评估的第 1 次修改拿到了完整差异摘要，仍主动修改主模板的本站序号检查，说明中承认超出要求；第 2 次未越界。仅展示差异不足以保证 Agent 撤销无关改动。补清修改任务提示词的结束条件：极端验证发现无关既有问题只记录，本轮不扩大范围；交回前逐项核对 `revision` 并撤销无关改动，截断部分读已保存模板核对。只重跑受影响的修改场景；数据定义另因既有的 13/15 边界波动补跑。原始失败报告保留。
- 2026-10-19 二次复核（[实测记录](../../../docs/agent-tooling-evaluation.md#票据-17)）：由 P1 降为 P2，排在票据 24 之后。
  - 不是"假合格"：修改范围本来就不进结论（M48），审核页的改动表照常列出全部差异。
  - 有记录的 3 次模板辅助修改里，只有 M215 那次多改了一处（道路段宽度上限 400 → 1500 mm），是 Agent 有意改的，说明里写明了，审核时接受（`docs/agent-validation.md:479`）；价签与 366 两次都只改了要求涉及的地方（`docs/stage3-acceptance.md:84`、`docs/stage3-acceptance.md:118`）。没有见到"无意中改多"。
  - 本票的价值是防无意改动，要靠修改场景的改动范围评分才量得出来，所以先做 24。
