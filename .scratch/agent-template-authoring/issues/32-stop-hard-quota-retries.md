# 32: 明确额度耗尽时终止本轮，不反复请求上游

**What to build:** 根据已观察到的结构化额度错误停止本轮；保留结果与续跑入口，瞬时限流及网络错误仍可由运行时处理。

**Priority:** P0

**Blocked by:** 无

**Status:** resolved

**Trace:** 第三阶段 PRD；2026-10-21 用户要求；[同图复跑报告](../../../docs/agent-arabic-retest.md)。

- [x] Google 转换代理遇到 GoUsageLimitError / weekly 等明确硬额度错误，第一次响应后不再派发上游调用。
- [x] 宿主主动终止该轮执行器并记录结构化停止原因、可读说明；结束时走成果与草稿保存路径。
- [x] Anthropic 直连运行的 stream-json 若明确报告硬额度，采用同样停止机制；一般 429、5xx、未知错误不误判为硬额度。
- [x] 真实本地 HTTP 上游模拟验证硬额度只收到一次请求、瞬时 429 可恢复、正常调用与密钥隔离无回归。
- [x] 实际额度恢复前不跑付费模型；真实额度路径与复跑转票据 38。

**测试接缝：** 公开 Agent / 渲染 / CLI 入口；资料变更的真实模型门槛在票据 38 统一验收。各票特有证据见条目。

## Answer

2026-10-21：按 M295 实施。`src/agent/quota.ts` 只分类明确硬额度类型；Google 代理在 HTTP 错误与 SSE 错误中识别并锁住后续调用。宿主停止本轮进程树、保存候选，`round.json.run.stopped` 记录 reason/type/limit；CLI 给出草稿路径和 --from 接续入口。只有普通 rate_limit 的运行时事件仍由原运行时处理。

- `test/agent.test.ts` 通过公开 runAgentTask 加真实 localhost HTTP 驱动：HTTP 和 SSE 两种硬额度响应各只收到一次上游请求；普通 429、503 后第三次 200；直连明确错误事件后假执行器的继续执行标记未出现；原凭据隔离检查通过。
- 评估队列 `scripts/agent-eval/eval.ts` 优先读取结构化 `run.stopped`，避免中文错误说明绕过旧文本分类；经假执行器验证第一个单元因硬额度 invalid 后，第 2、3 个单元不再启动。
- `npm test`：47 个文件、966 个用例全部通过（45.40 秒）；`npm run typecheck`、`npm run build`、`npm run typecheck:service`、`git diff --check` 通过。
- 偏差与边界：本机验证 Windows 进程停止；Linux 进程组分支尚未实跑。直连 Claude Code 若只暴露 rate_limit 而不暴露正文，无法提前识别硬额度；不能声称所有 429 都会立即停止。真实模型路径由票据 38 覆盖，本次未消耗付费模型额度。

## Comments

- 2026-10-21：用户确认排序并先实施 31、32；当前 Go 额度耗尽，其他票据按顺序后续推进。
