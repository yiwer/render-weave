# 23: 业务 Agent 的思考预算可设置、有记录，并用评估定缺省

**What to build:** `renderweave agent run` 与评估命令接受思考预算参数并写进 `round.json`，轮次用量里记下思考 token；用一次对照评估决定缺省值。在成绩不降的前提下，减少每轮的输出 token 与用时。

**Blocked by:** 21

**Status:** resolved

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

- [x] `--max-thinking-tokens` 传到子进程环境；不给时环境里没有这个变量。
- [x] `round.json` 记预算与 `thinkingTokens`；评估报告带上它们。离线用例用 `test/support/fake-claude.mjs` 输出带 `output_tokens_details` 的结果消息。
- [x] 价签数据定义提取一轮，确认预算生效与否，结论写进本票 `## Answer`。
- [x] 生效时跑对照评估，按切换条件定缺省，报告存档并写进 `docs/agent-eval.md`「历次评估」。
- [x] 全量 `npm test` 通过。

**测试接缝：** `runAgentTask` 的子进程环境与 `readUsage`；评估报告用 `buildReport` 的离线用例。

**不在本票：** Claude Code 的 effort 一类设置；模型选择（M232）。

## Answer

2026-10-20 完成。按"不生效就停"的规则，`MAX_THINKING_TOKENS` 这条路停下了，改用 `--effort` 做对照评估；缺省不改（M274）。

**MAX_THINKING_TOKENS 不生效（已验证）**

- 价签数据定义提取，预算 8,000 与不设各一轮：思考 5,378 与 7,647。但不设那一轮全程才 7,647，单次请求碰不到 8,000，这组对比说明不了什么。
- 换成看请求本身：在本机起一个记录中继（`--endpoint` 指向它，只记请求的 `thinking`、`output_config`、`max_tokens` 与响应用量，key 只在内存中经过）。
  - 预算 2,000 与不设各一轮，Claude Code 2.1.296 发出的请求完全相同：`thinking: {"type":"adaptive","display":"updates"}`、`max_tokens: 128000`，没有 `budget_tokens`。
  - Haiku 5.5 是自适应思考，这个变量被忽略；预算 2,000 那轮思考反而更多（7,225 对 4,797），是波动。
- `claude --help` 有 `--effort <level>`（low、medium、high、xhigh、max）。经同一个中继，`--effort low` 的请求带 `output_config: {"effort":"low"}`，不给时 Claude Code 发 `"medium"`。价签一轮的思考 2,016 对 8,333，输出 5,549 对 13,575。

**改成 effort（对票据的偏差）**

- `agent run --effort <low|medium|high|xhigh|max>` 传给 Claude Code 的 `--effort`；不给时不传。`round.json` 的 `runtime.effort` 记它，没给为 `null`。
- `run.thinkingTokens` 记结果消息的 `output_tokens_details.thinking_tokens`。
- 评估命令透传 `--effort`；报告 `runtime.effort`、轮次摘要与 `totals.thinkingTokens`，文字摘要写思考合计。
- 用例：`test/agent-rounds.test.ts`「推理力度与思考 token（票据 23）」两项。假执行器收到 `--effort low`、不给时不收到；`round.json` 记力度与思考 token；取值不对是用法错误。`test/agent-eval.test.ts` 断言报告的 `totals.thinkingTokens`。

**对照评估**

- [2026-10-20-effort-low](../../../docs/agent-eval/reports/2026-10-20-effort-low.json)（low）对比同一资料与合同的门槛评估 [2026-10-20-contract-060](../../../docs/agent-eval/reports/2026-10-20-contract-060.json)（medium）：

  | | medium | low |
  |---|---|---|
  | 门槛 | 通过 | 通过 |
  | 两个场景输出 tokens | 309,401 | 212,946（−31.2%） |
  | 其中 366 / M402 模板 | 145,171 / 164,230 | 94,959（−35%）/ 117,987（−28%） |
  | 思考 tokens | 228,775 | 140,685 |
  | 用时（各轮之和） | 60.4 分钟 | 54.7 分钟 |
  | M402 模板压测、地标底线 | 10、10；2、2 mm | 10、10；0、0 mm |
  | M402 模板相似度 | 0.898、0.936 | 0.870、0.908 |
  | 366 站名、地标、设施 | 58/15/18、59/15/18 | 59/15/18、58/15/18 |

- **切换条件不满足**：相似度 0.870 低于近三份报告的最低值 0.898（Gemini 2026-10-19 是 0.921、0.907，2026-10-20-ticket21 是 0.913、0.902）。其余各项都满足，输出降 31.2%，刚过 30%。缺省维持 Claude Code 的 medium。
- **观察**：提取类任务降得多、成绩不降，模板任务降得少、相似度下降。"只对提取类任务用 low"可能成立，但 M402 数据定义场景没在 low 下跑过，不能据此定，留作后续。
- **验证**：全量 `npm test` 通过，`npm run typecheck` 通过；两次评估的轮次目录与报告经 `scripts/scan-keys.mjs` 扫描，key 命中 0。

## Comments

- 2026-10-19 二次复核新开。排在票据 21 之后：对照评估要跑 8 个单元，碰上 429/500 时要能区分基础设施失败。
