# 22: MCP 工具的文字结果不超过 Claude Code 的落盘阈值

**What to build:** `renderweave mcp` 每个工具的文字结果都控制在 40,000 字符以内，超出时工具自己截断并告诉 Agent 怎么取剩下的部分；`dsl_reference` 能按 JSON Pointer 取模板 Schema 的一段。业务 Agent 不再收到它读不到的"已转存"结果。

**Blocked by:** 无

**Status:** ready-for-agent

**Trace:** M225（只读工具）、ADR-0015（受限模式的 Claude Code）；2026-10-19 [二次复核](../../../docs/agent-tooling-evaluation.md#新发现-1mcp-输出超过-50000-字符时-agent-拿不到)；验收 A09、A10。

背景：

- Claude Code 2.1.296 把超过 50,000 字符的工具文字结果转存到 `CLAUDE_CONFIG_DIR` 下的文件，只给模型约 2,000 字符的预览（实测：45,000 字符原样送达，55,000 字符转存；中文与 ASCII 一样按字符数算）。
- 业务 Agent 的 `CLAUDE_CONFIG_DIR` 在轮次的 `logs/` 下（`src/agent/run.ts:328`），`--restricted` 只允许读 `agent/` 工作目录，所以转存的文件读不到，等于这次调用白做。
- 已经发生：`dsl_reference` 的 `schema/template` 是 79,116 字符，4 次模板评估轮里有 2 次调了它，都被转存；其中一次 Agent 接着用 Glob 去找转存文件，被受限模式拒绝（`out/agent-eval/2026-10-18-check-outcome/run-1/m402-template/template/logs/stream.jsonl`）。两次都没拿到 Schema，Agent 只能凭参考文档写模板。
- 快到线的：`inspect_layout` 在 M402 上 depth 3 是 30,193 字符，depth 20 是 49,070 字符（`INSPECT_MAX_NODES = 300` 只限元素数、不限字符数，`src/mcp/tools.ts:46`）。站数更多、站名更长的模板会超线。中文结果约 1 字符 1 token，4.5 万字符的一次结果就占约 4.6 万 tokens 上下文。
- `tools.jsonl` 的摘要不记输出大小，评估报告也不查转存，这类问题只能翻 `stream.jsonl` 才看得到。

**决定**：

- **统一上限**：工具文字结果不超过 40,000 字符（给 50,000 留余量）。服务层在发出前检查；超出的工具要么在本票里改成分段返回，要么返回工具错误并说明怎么缩小范围，不能把超长结果交给客户端。
- **`dsl_reference`**：新增可选 `pointer`（JSON Pointer，如 `/$defs/text`），只对 `schema/*` 有效；`schema/template` 不带 `pointer` 时返回目录（顶层属性与 `$defs` 各项的名称和字符数），不再返回整份。`reference/*` 照旧整份返回（最长的 `reference/template` 17,006 字符）。
- **`inspect_layout`**：按字符预算收集元素，预算用完时停，返回 `truncated: true`、已返回与总元素数，并提示用 `elements` 指定子树或减小 `depth`。说明里写明预算。
- **问题清单**：`render_draft`、`inspect_layout`、`check_*` 的问题超过 200 条时只列前 200 条，另给按问题代码的计数。
- **观测**：`tools.jsonl` 每条记录加 `chars`（文字结果字符数）与 `imageBytes`；评估的轮次摘要统计 `stream.jsonl` 里被转存（`<persisted-output>`）或截断的工具结果数，非零时写进报告并在文字摘要里提示。
- **同批的小改动**（都在 0.6.0 里）：
  - `render_draft` 与 `inspect_layout` 收到 `mode: "final"` 时按草稿出图，在结果里注明 `modeDowngraded: true`，不再报工具错误。提示词让 Agent 照抄 `docs/request.json`，而那份请求带着 `"mode": "final"`（`src/agent/run.ts:246`），最近一次评估因此有 1 次工具错误；
  - `tools/list` 给 11 个工具加 `annotations: { readOnlyHint: true, openWorldHint: false }`（复核文档 P3）。
- 合同升 0.6.0，与票据 17、18、19 同批，只跑一次评估。

- [ ] 每个工具在仓库现有夹具上的最大输出都在 40,000 字符以内；服务层对超长结果有用例。
- [ ] `dsl_reference` 的 `schema/template` 不带 `pointer` 返回目录，带 `pointer` 返回那一段；`pointer` 不存在时是工具错误并列出可用的顶层名称。
- [ ] `inspect_layout` 在 M402 上 `depth: 20` 返回 `truncated` 与总数，结果不超过上限。
- [ ] `mode: "final"` 的请求能出草稿，结果带 `modeDowngraded`。
- [ ] `tools.jsonl` 有 `chars` 与 `imageBytes`；评估报告有转存/截断计数，离线用例用一段含 `<persisted-output>` 的假 `stream.jsonl`。
- [ ] 工具清单快照、`docs/mcp.md` 与合同版本更新；全量 `npm test` 通过；同批评估门槛通过，且转存计数为 0。

**测试接缝：** `test/mcp.test.ts` 经 JSON-RPC 驱动；输出大小的检查放在服务层（`src/mcp/server.ts`），用一个返回超长文字的假工具测。

**不在本票：** 把转存文件放进 Agent 能读的目录（会把 Claude Code 的配置目录暴露给 Agent）；靠调 Claude Code 的阈值绕过（阈值随版本变，工具自己守住上限更稳；`MAX_MCP_OUTPUT_TOKENS` 是否影响按字符的转存未测）。

## Comments

- 2026-10-19 二次复核新开。阈值来自两处：Claude Code 二进制中的常量 `p0=50000`（工具结果落盘阈值上限）与上面的实测；实测脚本 `out/probe-tooling-2/blob-test.mjs`（不进版本库）。升级 Claude Code 后要按 `docs/agent-eval.md` 跑评估，届时看报告里的转存计数。
