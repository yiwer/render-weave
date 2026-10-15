# 业务 Agent 任务

`renderweave agent run` 发起一轮业务 Agent 任务：在独占的轮次目录里组装资料，按 [ADR-0015](adr/0015-agent-runs-as-headless-claude-code-via-read-only-mcp.md) 启动一次 Claude Code 无头运行。

Agent 只连本仓库的 [MCP 只读工具服务](mcp.md)。结束后，RenderWeave 先校验 Agent 交回的成果结构，再用引擎校验候选文件。决定记录见 M226。

目前只实现**数据定义提取**。审核与应用见第三阶段票据 05，其余三种任务（数据集提取、模板辅助设计、模板辅助修改）见票据 06、07。

## 发起一轮

```bash
renderweave agent run --task 数据定义提取 --sample <示例图> --brief <项目说明.md> --resources <资源仓库> --out <新轮次目录> [--domain route-sign] [--workspace <工作区>]
```

| 选项 | 含义 |
|---|---|
| `--task` | 任务类型：`数据定义提取`，也可写英文标识 `definition-extraction` |
| `--sample` | 示例图，PNG、JPEG 或 WebP，按文件头判断格式，不看扩展名 |
| `--brief` | 项目说明：业务、尺寸、目标范围、客户说明。只写这一单的事实 |
| `--resources` | 资源仓库目录，Agent 经工具查看可引用的图片与字体 |
| `--out` | 新轮次目录，必须不存在或为空 |
| `--domain` | 可选，领域约定包，取 `agent/domains/<领域>.md`，目前有 `route-sign` |
| `--workspace` | 可选，工作区目录，复制为本轮的只读快照。Agent 可以引用其中已发布的数据定义，版本号接在快照之后 |
| `--key-env` | 可选，key 所在的环境变量名，缺省 `QWEN_TOKEN_PLAN_API_KEY` |
| `--model`、`--small-model`、`--endpoint` | 可选，缺省为千问 token plan 的 qwen3.8-max、qwen3.7-plus 与对应的兼容端点 |
| `--max-turns` | 可选，轮数上限，数据定义提取缺省 40 |
| `--claude` | 可选，Claude Code 可执行文件，缺省为 PATH 上的 `claude` |

**任务顺序**（M43）：数据集提取与模板辅助设计都要先有已发布的数据定义。只给示例图、没有指定数据定义时，命令提示先做数据定义提取。

**退出码**：

| 退出码 | 含义 |
|---|---|
| 0 | 成果合格 |
| 1 | 成果不合格，问题清单在 `check.json` 并写到标准错误流。是否带着问题重跑由人决定，不自动重试（M48） |
| 2 | 用法错误，或输入无法读取，或任务顺序不对。此时不创建轮次目录 |

**标准输出**是一段 JSON 摘要：轮次目录、结论、候选及其发布版本、待确认项数、用时与轮数。

## 隔离

- **环境**：子进程环境从空白开始，只放系统必需变量与模型配置，不继承宿主的 `CLAUDE_*`、`ANTHROPIC_*` 变量与登录凭据。
- **配置目录**：独立，放在轮次目录的 `logs/claude-config/`。
- **key**：只从环境变量读取，只在内存中传给子进程。轮次目录的任何文件里都没有 key，`round.json` 只记录变量名。
- **权限**：
  - 以 `--restricted` 运行，没有执行代码的工具，文件工具限于 Agent 工作目录；
  - `--strict-mcp-config` 只连 `renderweave mcp`；
  - 数据定义提取开放 7 个工具：`list_documents`、`read_document`、`list_resources`、`check_definitions`、`check_dataset`、`view_image`、`dsl_reference`。

## 轮次目录

| 路径 | 内容 |
|---|---|
| `agent/` | Agent 工作目录，即 MCP 服务的 `--root` |
| `agent/sample.<格式>` | 示例图 |
| `agent/docs/` | `brief.md`（项目说明）、`guide.md`（通用做法）、`domain-<领域>.md`（领域约定，如有）、`dsl-reference.md`（DSL 参考）、`outcome.md`（成果格式） |
| `agent/candidates/` | Agent 写的候选文件 |
| `agent/scratch/` | Agent 的自查草稿，不是成果 |
| `agent/outcome.json` | Agent 交回的成果 |
| `snapshot/` | 工作区快照，MCP 服务启动时读入 |
| `logs/` | `mcp.json`、`stream.jsonl`（Claude Code 流式输出）、`stderr.txt`、`tools.jsonl`（工具调用日志）、`claude-config/` |
| `round.json` | 轮次记录：输入、运行参数、用量与结论，无论成果是否合格都写出 |
| `check.json` | 校验结果：结构问题与每个候选的问题 |
| `outcome.json` | 轮次成果，结构合格时才写出 |
| `candidates/` | 候选文件的副本，之后审核与应用都读这里 |

提示词取 `agent/tasks/<任务>.md`，只写三层资料的优先级与做事步骤，不含具体业务。

## 成果

### Agent 交回的 outcome.json

格式写在 [agent/reference/outcome.md](../agent/reference/outcome.md)，它同时是交给 Agent 的资料。要点如下：

- `candidates`：候选文件列表，必须在 `candidates/` 下，种类符合任务。数据定义提取只交数据定义（M43），按示例图写的数据集只能作为 `scratch/` 中的自查草稿。
- `pending`：待确认项。
  - `file` 指向一个候选；
  - `path` 是位置：数据定义写字段名，数据集写字段路径；
  - `candidate` 是候选值，可以没有；
  - `reason` 是原因，取 M44 的四类之一：`unreadable`（看不清）、`inferred`（推测）、`conflicting`（来源冲突）、`requiredMissing`（必填未提供）；
  - `note` 是说明。
- `notes`：给审核人的说明。

### 校验

1. **结构**：先查以下几项，任一不合格都报 `outcome.invalid`：
   - `outcome.json` 是否可读、是否符合格式；
   - 候选文件是否在 `candidates/` 下、可读、种类对；
   - 数据定义名称是否重复；
   - 待确认项是否指向候选，字段是否存在。
2. **引擎**：数据定义按依赖顺序在内存中发布，引用其他候选的定义放在后面。版本号接在工作区快照之后，问题带位置。
3. **结论**：结构合格且候选没有严重问题时为"合格"。

### 轮次成果 outcome.json

结构合格时写出，格式标识 `renderweave-outcome/1`：

| 键 | 内容 |
|---|---|
| `task`、`round` | 任务类型与轮次，首轮为 1 |
| `inputs` | 示例图的 SHA-256、工作区快照指纹、上一轮（首轮为 `null`）。应用前用指纹判断工作区是否已变（M51） |
| `candidates` | 路径、种类、名称、SHA-256；数据定义另有在内存中发布成的名称与版本 |
| `pending`、`notes` | 来自 Agent 交回的内容 |
| `usage` | 用时、轮数、输入与输出 token、缓存 token、实际服务的模型、Claude Code 版本、结束方式（如 `success`、`error_max_turns`） |

工作区指纹是快照中各 JSON 文件的文件名与内容哈希，按文件名排序后再整体取 SHA-256。

## 测试

`test/agent.test.ts` 用假执行器 `test/support/fake-claude.mjs` 代替 Claude Code，不调用模型。假执行器复制预置成果，记录收到的参数与环境变量名。覆盖以下几方面：

- 资料组装、受限启动参数与 MCP 配置；
- 环境隔离与 key 泄漏扫描；
- 合格成果；
- 不合格成果：没有交回、执行器无法启动、候选有严重问题，以及成果校验入口 `checkAgentOutcome` 的 12 种结构问题；
- 命令行的用法错误与退出码。

真实运行的记录见 [Agent 运行方式验证](agent-validation.md#产品命令首次实跑票据-04)。
