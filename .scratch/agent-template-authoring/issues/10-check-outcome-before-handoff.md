# 10: Agent 交回前用只读工具核对成果

**What to build:** Agent 在交回前调用只读工具 `check_outcome`，按 RenderWeave 收成果时的同一套规则核对 `outcome.json` 与候选文件，不再因为待确认项或图上位置引用的路径对不上而白跑一轮。

**Blocked by:** 07、08

**Status:** resolved

**Trace:** 第三阶段 PRD 第 9 条（成果校验）；[第三阶段验收](../../../docs/stage3-acceptance.md) Spec 审查第 1 项、「后续」第 1 条；验收 A04、A10。

- [x] `renderweave mcp` 新增只读工具 `check_outcome`：
  - 没有参数，读工作目录根上的 `outcome.json`；
  - 与 `agent run` 交回后的校验是同一份实现，返回结论、结构问题与每个候选的问题，数据集落在待确认位置上的问题单列；
  - 不写任何文件。
- [x] `renderweave mcp --outcome-context <JSON 文件>` 给出本轮任务与已知输入（所选数据定义、主模板、可修改的模板）。没给时调用 `check_outcome` 返回工具错误；文件不合规是用法错误。
- [x] `agent run` 把本轮任务与已知输入写到 `logs/outcome-context.json` 并交给 MCP 服务；四种任务都开放 `check_outcome`。上下文放在 Agent 工作目录之外，Agent 改不了。
- [x] 资料：四个任务提示词的最后一步与 `outcome.md` 要求交回前用 `check_outcome` 核对，结论为 `qualified` 再结束。
- [x] 合同升到 0.4.0；工具清单快照、[MCP 工具服务](../../../docs/mcp.md)、[业务 Agent 任务](../../../docs/agent-tasks.md)同步。
- [x] 全量测试、类型检查、构建通过。改了资料与合同，按 M230 跑评估门槛（缺省模型 Haiku 5.5），连续两次达线。

**测试接缝：** `test/mcp.test.ts` 经 `runCli` 驱动 `renderweave mcp`；`agent run` 交给 MCP 服务的参数与上下文文件，经假 Claude Code 的轮次目录核对。

## Answer

2026-10-18 完成。决定见 M233。

**成果**

- `check_outcome`（`src/mcp/tools.ts`）直接调用 `checkAgentOutcome`，返回与 `check.json` 相同的结论与问题，只去掉 `sha256` 和 `revision`。
- `--outcome-context`（`src/cli.ts`）由 `parseOutcomeTarget`（`src/agent/outcome.ts`）按 Schema 检查；不合规时退出码 2。
- `agent run`（`src/agent/run.ts`）在启动 Claude Code 之前写 `logs/outcome-context.json`；交回后的校验用的是同一份上下文。
- 资料：`agent/tasks/` 四个提示词各加最后一步，`agent/reference/outcome.md` 开头加一句。
- 文档：[MCP 工具服务](../../../docs/mcp.md#交回前核对)、[业务 Agent 任务](../../../docs/agent-tasks.md#校验)、[Agent 评估](../../../docs/agent-eval.md#历次评估)。

**验证**

- **先写失败的测试**：10 项先变红，实现后转绿。
  - `test/mcp.test.ts` 新增 3 项：没有上下文时报工具错误；路径对不上的待确认项不合格、改对后合格、不写文件；上下文文件的用法错误。
  - `test/agent.test.ts` 新增 1 项：照本轮 `logs/mcp.json` 的参数启动 MCP 服务，`check_outcome` 的结论与问题和 `check.json` 相同。
  - 三个 agent 测试文件核对每种任务的工具清单与上下文文件内容。
  - 工具清单快照只多了 `check_outcome`，原有 10 个工具不变。
- **Windows**：`npm run typecheck`、`npm run build` 通过；`npm test` 39 个文件、749 项通过。
- **Linux 容器** `node:22-alpine`（v22.23.3）：同一份工作树，`npm ci`、构建、类型检查通过；745 项通过、4 项 Windows 专用用例跳过。
- **评估门槛**（Haiku 5.5，Claude Code 2.1.296，合同 0.4.0）通过：
  - [2026-10-18-check-outcome](../../../docs/agent-eval/reports/2026-10-18-check-outcome.json)：M402 数据定义 2/2，M402 模板 2/2。366 第 1 次站名 56/59，差一站没达线，三处都是长站名错一个字；第 2 次 59/59。
  - [2026-10-18-check-outcome-366](../../../docs/agent-eval/reports/2026-10-18-check-outcome-366.json)：只重跑 366，57、59，2/2 达线。
  - 两份报告共 12 轮，每轮都在交回前调用了 `check_outcome`（11 轮一次、1 轮两次），第一次就 `qualified`。这几次评估没有出现路径对不上，所以省掉的返工这次没测到；它的作用要在之后的实跑中看。
- **key 扫描**：两个评估目录加 `docs src scripts test agent .scratch`，709 个文件，命中 0。

**偏差**

- **评估重跑**：366 的余量比 0.3.0 时薄（56、59、57、59，通过线 57）。按票据 08 的先例换新 label 只重跑 366，M402 沿用第一份报告。有一次重跑被 OpenCode 上游的 500 打断，删掉了，不出报告。
- **Gemini 4 Argon** 没有在 0.4.0 上复跑。按 M230，用它之前要先跑一遍，约 72 分钟、按标价约 $14。
- **新设备的环境问题**另写进了[开发环境与接续](../../../docs/dev-setup.md)「已知的坑」：npm 装的 Claude Code 只有 `claude.cmd`，`agent run` 找不到；Docker 把宿主的 127.0.0.1 代理注入了容器。
