# 23: 业务 Agent 的思考预算可设置、有记录，并用评估定缺省

**What to build:** `renderweave agent run` 与评估命令接受思考预算参数并写进 `round.json`，轮次用量里记下思考 token；用一次对照评估决定缺省值。在成绩不降的前提下，减少每轮的输出 token 与用时。

**Blocked by:** 21

**Status:** ready-for-agent

**Trace:** M232（模型与成本）、ADR-0015；2026-10-19 [二次复核](../../../docs/agent-tooling-evaluation.md#新发现-2思考-token-是最大的成本与耗时来源)；验收 A10。

背景：

- 现有 14 个评估轮次里，思考 token 占输出 token 的 74–87%：M402 模板轮输出 78–90k，其中思考 58–67k；366 数据定义轮输出 32–59k，其中思考 25–51k（`out/agent-eval/*/run-*/*/*/logs/stream.jsonl` 结果消息的 `output_tokens_details.thinking_tokens`）。
- 按 Haiku 4.5 的公开单价推算比例（OpenCode Go 是额度制，只看比例）：输出 token 占每轮费用的 52–63%，图片约占一成到两成半。思考是最大的一项，也是用时的主要来源。
- 推断思考内容在工具循环里一直留在上下文中：366 数据定义 run-1 最后一次请求的上下文 121k，能对上的系统提示（7.8k）、图片（按像素数 / 750 约 42k）与文字（39k 字符，按 1.5 字符/token 约 26k）合计约 76k，差额约 45k，与这一轮 46k 的思考 token 相当；M402 模板 run-1 差额约 52k、思考 65k。文字的换算比例是估的。如果属实，思考还会抬高每一步的缓存读取。
- `agent run` 的子进程环境从空白开始，没有设 `MAX_THINKING_TOKENS`（`src/agent/run.ts:323-332`），Claude Code 2.1.296 支持这个变量；`readUsage` 也不记思考 token（`src/agent/run.ts:565-567`），报告里看不到这一项。

**决定**：

- `agent run` 新增 `--max-thinking-tokens <数>`，传给子进程的 `MAX_THINKING_TOKENS`；不给时不设，行为与现在相同。`round.json` 的 `runtime` 记这个值（没设记 `null`），`run` 与轮次摘要记 `thinkingTokens`。
- 评估命令透传同名参数；报告的 `runtime` 与 `totals` 带上它与思考 token 合计。
- 先确认这个变量对 OpenCode Go 上的 Haiku 5.5 生效：设 8,000 跑一轮价签数据定义提取，`thinkingTokens` 应明显低于缺省。不生效就停在这一步，记录结论，不做对照评估。
- 对照评估：`m402-template` 与 `366-transcription` 各 2 次，预算取 16,000 与 8,000 两档（缺省的成绩用最近的报告）。
- **切换条件**：某一档门槛通过、各项成绩不低于近三份报告的最低值，且两个场景的输出 token 合计下降 30% 以上，就把它定为缺省，记 M 编号；否则维持不设，在 `docs/agent-eval.md` 记下结果。Gemini 走转换代理，不在本票。

- [ ] `--max-thinking-tokens` 传到子进程环境；不给时环境里没有这个变量。
- [ ] `round.json` 记预算与 `thinkingTokens`；评估报告带上它们。离线用例用 `test/support/fake-claude.mjs` 输出带 `output_tokens_details` 的结果消息。
- [ ] 价签数据定义提取一轮，确认预算生效与否，结论写进本票 `## Answer`。
- [ ] 生效时跑对照评估，按切换条件定缺省，报告存档并写进 `docs/agent-eval.md`「历次评估」。
- [ ] 全量 `npm test` 通过。

**测试接缝：** `runAgentTask` 的子进程环境与 `readUsage`；评估报告用 `buildReport` 的离线用例。

**不在本票：** Claude Code 的 effort 一类设置；模型选择（M232）。

## Comments

- 2026-10-19 二次复核新开。排在票据 21 之后：对照评估要跑 8 个单元，碰上 429/500 时要能区分基础设施失败。
