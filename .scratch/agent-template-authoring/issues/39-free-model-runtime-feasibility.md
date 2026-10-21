# 39: 核实免费模型的运行时限制与业务适用性

**What to build:** 记录 DeepSeek V4.1 Flash Free 的平台限制；若改用 OpenCode 客户端，单独验证运行时与模型能力。

**Priority:** P2

**Blocked by:** 无

**Status:** ready-for-agent

**Trace:** 第三阶段 PRD；2026-10-21 用户要求；[同图复跑报告](../../../docs/agent-arabic-retest.md)。

- [x] 保留 2026-10-21 官方模型表及最小调用返回 403 FreeTierError 的证据，明确免费层仅限 OpenCode 客户端。
- [x] 不伪装客户端、不绕过平台限制；当前 Claude Code 运行时不能只改模型名直接使用。
- [ ] 若采用 OpenCode 客户端，重新验证隔离、只读 MCP、文件交回、工具调用和看图；通过前不替换 Haiku/Gemini。

**测试接缝：** 公开 Agent / 渲染 / CLI 入口；资料变更的真实模型门槛在票据 38 统一验收。各票特有证据见条目。

## Comments

- 官方模型表：[OpenCode Models](https://dev.opencode.ai/v2/docs/console/models)。最小文字请求 `deepseek-v4.1-flash-free` 到官方 OpenAI 兼容端点，返回 403 / FreeTierError：免费层只可在 OpenCode 内使用。原始结果：`out/arabic-board-retest-2026-10-20/free-model-probe.json`。遇到限制后停止，未继续看图与工具能力测试；这两项目前未知。

- 2026-10-21：用户确认排序并先实施 31、32；当前 Go 额度耗尽，其他票据按顺序后续推进。
