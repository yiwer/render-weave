# 04: 一条命令发起数据定义提取，拿到可校验的成果

**What to build:** 代建工程师用 `renderweave agent run --task 数据定义提取 --sample … --brief … [--domain …]` 发起一轮，在独占的轮次目录里得到 `outcome.json`、候选文件，以及 RenderWeave 重新校验的结果。

**Blocked by:** 03

**Status:** resolved

**Trace:** 第三阶段 PRD；用户故事 1–6、16–18；验收 A05、A06。

- [x] 按 ADR-0015 启动 Claude Code：
  - 受限模式，空白环境，独立配置目录，只连 `renderweave mcp`；
  - key 只从环境变量读取；
  - 模型与端点可配置，缺省为千问 token plan 的 qwen3.8-max。
- [x] 轮次目录组装三层资料（通用指南、领域约定、项目说明）、DSL 参考与示例图；提示词不含具体业务。
- [x] `outcome.json` 合同包括：
  - 任务类型与轮次；
  - 基于的输入：示例图哈希、工作区指纹；
  - 候选文件；
  - 待确认项：位置、候选值（可空）、原因（M44 四类）；
  - 说明与用量：用时、轮数、token。
- [x] 先做结构校验，再用引擎校验候选；不合格时给问题清单，用退出码区分，不自动重试。
- [x] 隔离测试：子进程环境中没有宿主的 `CLAUDE_*`、`ANTHROPIC_*` 变量；在全部产物中搜索 key，0 命中。
- [x] 只给图片、没有指定数据定义时，命令提示先做数据定义提取。
- [x] 不依赖模型的测试：用构造的 `outcome.json` 与候选覆盖合格、不合格两条路径。另在本机用真实 key 跑一次 M402，并记录结果。

**测试接缝：** 公开 CLI 与成果校验入口。模型调用可以替换为读取预置成果的假执行器，用来测试流程。

## Answer

2026-10-14 已完成。

**成果**

- **命令** `renderweave agent run`，实现在 `src/agent/`：
  - `tasks.ts`：四种任务类型（M43），英文标识与中文名称都可用；
  - `run.ts`：启动器；
  - `outcome.ts`：成果校验入口 `checkAgentOutcome`。

  说明见 [docs/agent-tasks.md](../../../docs/agent-tasks.md)，决定见 M226。
- **启动**（ADR-0015）：
  - 环境按白名单组装，配置目录在 `logs/claude-config/`；
  - 受限模式，`--strict-mcp-config` 只连 `dist/bin.js mcp`；
  - 工作区快照与 Agent 工作目录分开，MCP 工具按任务开放，数据定义提取开放 7 个；
  - key 只从 `--key-env` 指定的环境变量读取（缺省 `QWEN_TOKEN_PLAN_API_KEY`），`round.json` 只记录变量名；
  - 模型、轻量任务模型、端点与轮数上限都可配置。
- **轮次目录**：
  - `agent/` 内有示例图（按文件头定扩展名）、`docs/` 下的项目说明、通用做法、领域约定、DSL 参考与成果格式，以及 `candidates/`、`scratch/`；
  - 另有 `snapshot/`、`logs/`。
- **资料**：
  - 提示词在 `agent/tasks/definition-extraction.md`，只写优先级与步骤，测试核对其中不含业务词；
  - 成果格式在 `agent/reference/outcome.md`，示例用会议胸牌；
  - 通用指南与线路牌约定提前迁到 `agent/guide.md`、`agent/domains/route-sign.md`，验证脚本改读新位置。
- **成果**：
  - Agent 交回 `agent/outcome.json`（候选、待确认项、说明）；
  - 结构合格时，RenderWeave 写 `outcome.json`（`renderweave-outcome/1`：任务与轮次、示例图哈希、工作区指纹、候选及其 SHA-256 与发布版本、待确认项、说明、用量），并把候选复制进轮次目录；
  - `check.json` 与 `round.json` 总是写出。
- **校验**：
  - 结构问题报 `outcome.invalid`：缺少文件、格式、候选位置与种类、名称重复、待确认项指向；
  - 引擎按依赖顺序在内存中发布数据定义，版本接在快照之后；
  - 退出码 0 合格、1 不合格、2 用法错误。
- **任务顺序**：数据集提取与模板辅助设计没有 `--definition` 时，提示先做数据定义提取；其余任务类型报尚未实现。

**不依赖模型的测试**（`test/agent.test.ts`，19 项；假执行器 `test/support/fake-claude.mjs`）

- **资料组装**：五份资料与示例图逐字一致；快照文件齐全；提示词等于任务模板，且不含业务词；M402 示例图（.jpg 文件名、PNG 内容）存为 `sample.png`。
- **启动与隔离**：
  - Claude Code 参数逐项核对；MCP 配置只有 `rw` 一个服务，参数为快照、资源仓库、工作目录、日志与 7 个工具；
  - 宿主设了 `ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL` 与 `CLAUDE_CODE_HOST_FLAG`，子进程中的 `CLAUDE_*`、`ANTHROPIC_*` 恰为启动器自己设的 9 个；
  - 轮次目录全部文件中搜索 key，0 命中。
- **合格**：`outcome.json` 各字段齐全；引用其他候选的定义排在前面也能按依赖发布；与快照同名的定义发布为 v2；候选副本与原件一致；用量取自流式输出。
- **不合格**：
  - 没有交回 `outcome.json`：不写 `outcome.json`，`round.json` 记为不合格；
  - 执行器无法启动；
  - 候选约束冲突：结构合格但有严重问题。
- **成果校验入口**：12 种结构问题各有用例。
- **命令行**：8 种用法错误退出码为 2，且不创建轮次目录；成果不合格时退出码为 1，并给出摘要。
- **能否变红已验证**：
  - 临时让子进程继承宿主全部环境变量，隔离用例失败；
  - 临时把 key 写进 `round.json`，泄漏扫描失败；
  - 两处都已恢复。

**真实运行**（M402，通用指南 + 线路牌约定，qwen3.8-max，详见[验证记录](../../../docs/agent-validation.md#产品命令首次实跑票据-04)）

- **结论**：合格，退出码 0。两份数据定义都发布成功，0 问题。
- **用量**：10.8 分钟、26 轮、32.4k 输出 tokens；工具调用 15 次，0 错误；服务 `rw:connected`。
- **质量**：
  - 专家字段 15 个对上 13 个：没建运营方（当作固定标识，写进了说明）与班车类型（列为待确认）；
  - 6 项约定全对；
  - 在 `scratch/` 写了数据集草稿自查，没有当作成果交回。
- **安全**：轮次目录与命令输出共 24 个文件，搜索 key 0 命中。

**验证**：`npm test` 35 个文件 / 697 项通过（本票新增 19 项）；`npm run typecheck`、`npm run build` 通过。

**偏差与说明**

- 通用指南与线路牌约定提前迁入 `agent/`（原属票据 08）：产品命令要用它们。项目说明模板、归属规则与评估仍在 08。
- 验证脚本读 key 时会回退到 Windows 用户级环境变量，产品命令不做这一步，只读当前进程的环境变量。
- `--definition` 目前只用于任务顺序的检查，写法在票据 06 确定。
