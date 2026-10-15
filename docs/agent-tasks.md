# 业务 Agent 任务

`renderweave agent run` 发起一轮业务 Agent 任务：在独占的轮次目录里组装资料，按 [ADR-0015](adr/0015-agent-runs-as-headless-claude-code-via-read-only-mcp.md) 启动一次 Claude Code 无头运行。

Agent 只连本仓库的 [MCP 只读工具服务](mcp.md)。结束后，RenderWeave 先校验 Agent 交回的成果结构，再用引擎校验候选文件。代建工程师用 `renderweave agent review` 在本地审核页审核成果，审核通过后用 `renderweave agent apply` 写入工作区。决定记录见 M226（发起与成果）、M227（审核与应用）。

目前只实现**数据定义提取**及其审核、发布。其余三种任务（数据集提取、模板辅助设计、模板辅助修改）见第三阶段票据 06、07。

流程：

```text
agent run（发起一轮）→ agent review（审核页：逐项处理待确认项、整体确认、通过）→ agent apply（发布为静态数据定义）
```

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
| `review.json` | 审核结果，由审核页写出（见[审核](#审核)） |
| `applied.json` | 应用记录，应用成功后写出；有它就不能再应用（见[应用](#应用)） |

提示词取 `agent/tasks/<任务>.md`，只写三层资料的优先级与做事步骤，不含具体业务。

## 成果

### Agent 交回的 outcome.json

格式写在 [agent/reference/outcome.md](../agent/reference/outcome.md)，它同时是交给 Agent 的资料。要点如下：

- `candidates`：候选文件列表，必须在 `candidates/` 下，种类符合任务。数据定义提取只交数据定义（M43），按示例图写的数据集只能作为 `scratch/` 中的自查草稿。
- `locations`：可选，字段在示例图上的位置，供审核人对照。
  - `file` 指向一个候选，`path` 是字段名（省略表示整份文件）；
  - `where` 是文字描述；
  - `region` 可选，是示例图上的像素区域 `{x, y, width, height}`，写法与 `view_image` 相同。

  这是 Agent 的自述，不是识别证据（M220）。
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
| `locations`、`pending`、`notes` | 来自 Agent 交回的内容；没交 `locations` 时为空列表 |
| `usage` | 用时、轮数、输入与输出 token、缓存 token、实际服务的模型、Claude Code 版本、结束方式（如 `success`、`error_max_turns`） |

工作区指纹是快照中各 JSON 文件的文件名与内容哈希，按文件名排序后再整体取 SHA-256。

## 审核

```bash
renderweave agent review <轮次目录> [--port <端口>] [--no-open]
```

命令在 `127.0.0.1` 上启动审核页，打开默认浏览器，并把地址打印到标准输出；按 Ctrl+C 结束。有 `outcome.json` 的轮次都能审核，成果校验不合格的也可以，处理后没有严重问题才能通过。

**页面内容**：

| 区域 | 内容 |
|---|---|
| 示例图 | 适应窗口、100%、200%、400%，单击放大、Shift+单击缩小；点"定位"跳到字段在图上的区域并框出 |
| 审核结论 | 待确认项处理进度、"其余内容已整体确认"、备注或理由、通过与不通过、撤回结论，以及还不能通过的原因 |
| 待确认项 | 每项一张卡片：原因、位置、Agent 的说明、候选值、候选文件中的当前写法，以及三种处理方式 |
| 候选数据定义 | 字段清单（名称、显示名称、类型、约束、图上位置、说明、相关的待确认项）；按审核结果在快照上于内存中重新发布，给出将发布的版本与编译产物摘要（属性数、必填字段、完整 JSON Schema）；引擎问题 |
| Agent 的说明 | `notes`，以及用时、轮数、输出 token 与模型 |

Agent 写的说明与候选内容一律按纯文本显示，不当作 HTML。

**处理待确认项**（M47）：

| 处理方式 | `action` | 数据定义中的效果 |
|---|---|---|
| 采纳候选 | `adopt` | 保留候选文件中该位置的写法 |
| 改值 | `edit` | 用审核人写的值替换该位置：有 `path` 时是整个字段，没有时是整份定义 |
| 标为空 | `empty` | 删去该位置：有 `path` 时删去该字段，没有时不发布这份候选 |

待确认项全部处理、其余内容整体确认、引擎校验没有严重问题，三者都满足才能通过。以下情况也会报出：

- 两个待确认项指向同一位置，但处理结果不同；
- 同一份候选既整份处理、又处理了其中的字段。

给出结论（通过或不通过）后，要先撤回结论才能再改；应用后不能再改。

**review.json**（`renderweave-review/1`）：

| 键 | 内容 |
|---|---|
| `outcomeSha256` | 所审核的 `outcome.json` 的 SHA-256。成果变了，审核结果作废 |
| `status` | `inProgress`（审核中）、`approved`（通过）、`rejected`（不通过） |
| `decisions` | 每项含 `item`（待确认项序号，从 1 开始）、`file`、`path`、`action`；改值时另有 `value` |
| `restConfirmed` | 其余内容已整体确认 |
| `comment` | 不通过的理由，或通过时的备注 |
| `updatedAt`、`decidedAt` | 最后修改时间与给出结论的时间 |

- 每次操作立即整份替换 `review.json`，所以关闭页面后重新打开，可以接着审核。
- `review.json` 在 Agent 工作目录之外，Agent 写不到。
- 公开入口 `readReview`、`changeReview` 读写同一份文件，页面只是它们之上的一层。

**本地服务的边界**：

- 只绑定 `127.0.0.1`，只服务一个轮次目录；
- `Host` 必须是本机地址加本服务端口，防止 DNS 重绑定；
- 写操作必须是 `application/json`，`Origin` 若有必须是本服务。其他网页即使知道端口，也改不了审核结果。

## 应用

```bash
renderweave agent apply <轮次目录> [--workspace <目录>] [--overwrite]
```

把审核通过的一轮写入工作区：数据定义经发布入口发布为下一个版本（M18），在工作区写出 `schema-<名称>-v<版本>.json` 与 `compiled-<名称>-v<版本>.schema.json`。文件名取候选文件名，规则与 `renderweave publish` 相同。审核时改过的内容以审核结果为准。

- **工作区**：缺省为发起本轮时的 `--workspace`；发起时没有给工作区的，必须用 `--workspace` 指定。
- **拒绝**：以下情况拒绝应用，退出码为 1，工作区一字不变：
  - 没有 `review.json`；
  - 审核还在进行，或审核未通过；
  - 候选或成果自生成后被改动；
  - 本轮已经应用过（有 `applied.json`）；
  - 工作区指纹与成果记录的不同。

  工作区指纹不同时，标准错误流列出差异：同名数据定义在快照之后发布的新版本、新增、删除与修改的文件。之后由人选择：
  - **覆盖**：加 `--overwrite`，按当前工作区发布为下一个版本；
  - **重做**：基于当前工作区重新发起一轮。
- **覆盖时的引用**：版本号可能后移。例如别人已经发布了场次 v1，本轮的场次就发布为 v2。候选之间的引用随之改到新版本；引用工作区中已有定义的不变。
- **原子性**：全部定义先在当前工作区上于内存中发布，全部成功才写文件。文件排他创建，绝不覆盖；任何一个写入失败，或应用记录写不出，就撤回本次已写的文件。
- **应用记录** `applied.json`（`renderweave-applied/1`）：
  - 应用时间、工作区、是否覆盖；
  - 三个指纹：成果所基于的、应用前、应用后；
  - 发布的名称、版本与文件；
  - 覆盖时另有差异。

**退出码**：0 已应用；1 拒绝或失败；2 用法错误或工作区无法读取。标准输出是一段 JSON：工作区、是否覆盖、发布的名称、版本与文件。

## 测试

`test/agent.test.ts` 用假执行器 `test/support/fake-claude.mjs` 代替 Claude Code，不调用模型。假执行器复制预置成果，记录收到的参数与环境变量名。覆盖以下几方面：

- 资料组装、受限启动参数与 MCP 配置；
- 环境隔离与 key 泄漏扫描；
- 合格成果；
- 不合格成果：没有交回、执行器无法启动、候选有严重问题，以及成果校验入口 `checkAgentOutcome` 的 15 种结构问题；
- 成果格式文档中的示例本身结构合格；
- 命令行的用法错误与退出码。

`test/agent-review.test.ts` 用同一个假执行器造出轮次，经 `readReview`、`changeReview`、`applyAgentRound` 与命令行覆盖以下几方面：

- **审核视图**：字段清单、图上位置、编译产物摘要；
- **审核操作**：逐项处理与整体确认；关闭后重开；撤回结论；
- **拒绝的情形**：不合规的操作、改值后不合格、同一位置处理不一致、整份标为空、审核结果与成果对不上、候选被改动；
- **应用**：
  - 未审核、审核中与未通过时不能应用；
  - 通过后发布为新版本，审核改动以审核结果为准；
  - 不能重复应用；
  - 工作区变化时给出差异；覆盖后候选间的引用改到新版本；
  - 写入失败时撤回；
- **审核页服务**：页面、示例图、读写审核结果；拒绝跨站与非本机 Host 的请求；Ctrl+C 后结束。

审核页另在浏览器里手动走查，截图存档，见[验证记录](agent-validation.md#审核与应用走查票据-05)。

真实运行的记录见 [Agent 运行方式验证](agent-validation.md#产品命令首次实跑票据-04)。
