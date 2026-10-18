# MCP 只读工具服务

`renderweave mcp` 是交给业务 Agent 的工具服务，任何 MCP 客户端也都能用。它在标准输入输出上收发按行分隔的 JSON-RPC 2.0（MCP 的 stdio 传输），提供读取、校验、草稿预览、元素检查、局部放大、资源列表、DSL 参考与交回前核对成果。

所有工具都只读（M53）。Agent 的成果以文件形式写在本轮工作目录里，经人审核后才能应用（ADR-0015）。决定记录见 M225，交回前核对见 M233。

## 启动

```bash
renderweave mcp --workspace <工作区目录> --resources <资源仓库> --root <本轮工作目录> [--tools <工具,…>] [--log <调用日志.jsonl>] [--outcome-context <本轮任务.json>]
```

| 选项 | 含义 |
|---|---|
| `--workspace` | 工作区目录。启动时读入为**快照**，之后目录再怎么改，本轮都看不到 |
| `--resources` | 资源仓库目录（`resources.json`；版本仓库取各资源的最新版本） |
| `--root` | 本轮工作目录。读文件的工具只能读这个目录里的文件 |
| `--tools` | 可选，只开放列出的工具，逗号分隔；工具名写错时报用法错误 |
| `--log` | 可选，每次工具调用追加一行记录：工具、参数、用时、是否出错。日志由启动方保存，不经工具读写 |
| `--outcome-context` | 可选，`check_outcome` 要的本轮任务与已知输入，JSON 文件，见[交回前核对](#交回前核对)。不给时 `check_outcome` 返回工具错误 |

- **退出码**：0 表示读完标准输入后正常结束；2 表示用法错误，或工作区、工作目录、`--outcome-context` 的文件无法打开或不合规。
- **输出约定**：标准输出只写协议消息，启动说明与工作区问题写到标准错误流。

Claude Code 的配置示例（`--mcp-config`）：

```json
{ "mcpServers": { "rw": { "type": "stdio", "command": "node",
  "args": ["<仓库>/dist/bin.js", "mcp", "--workspace", "<快照>", "--resources", "<资源仓库>", "--root", "<本轮工作目录>"] } } }
```

## 工具

工具名、输入 Schema 与说明以 `tools/list` 为准，快照见 [test/snapshots/mcp-tools.json](../test/snapshots/mcp-tools.json)。

| 工具 | 输入 | 返回 |
|---|---|---|
| `list_documents` | 无 | 快照中的静态数据定义、模板、数据集，以及读取工作区时发现的问题 |
| `read_document` | `kind`：`definition`、`compiled`、`template` 或 `dataset`；另写 `name`、`version` 或 `id` | 文档 JSON 原文。内置数据定义可以按 `compiled` 读 |
| `list_resources` | 无 | 资源 ID 与种类 |
| `check_definitions` | `paths`（按顺序，被引用的在前）、`includeCompiled` | 每个文件将发布成的名称与版本、带位置的问题。版本号接在快照中同名定义之后 |
| `check_dataset` | `path`、`definitionPaths` | 按所选定义的编译产物校验，问题带字段路径。定义可以来自快照，也可以来自候选 |
| `check_templates` | `paths` | 模板工作副本的静态检查，问题带元素路径，同一问题只报一次 |
| `render_draft` | `request`、`templates`、`datasetPath`、`region` | 问题清单与 PNG 图片内容块 |
| `inspect_layout` | `request`、`templates`、`datasetPath`、`elements`、`depth` | 元素的布局摘要与这些元素上的问题 |
| `view_image` | `path`、`region`（像素） | 原图尺寸、裁切区域与放大后的 PNG |
| `dsl_reference` | `name` | `agent/reference/` 中的参考，或 `schemas/` 中的 JSON Schema 原文 |
| `check_outcome` | 无 | 按交回后的同一套规则核对工作目录根上的 `outcome.json` 与候选：结论 `verdict`、`outcome.json` 的问题，以及每个候选的问题与 `deferred` |

工具结果是一段 JSON 文本，预览类工具再加一个图片内容块。

### 交回前核对

`check_outcome` 调用 `agent run` 交回后用的同一个校验（[业务 Agent 任务](agent-tasks.md#校验)），Agent 在交回前就能看到同样的结论与问题，包括待确认项与图上位置引用的路径对不上（M233）。

- **输入**：没有参数，固定读工作目录根上的 `outcome.json`。
- **上下文**：`--outcome-context` 的文件写本轮任务与已知输入：

  ```json
  { "task": "template-revision", "request": { "template": "标准线路单边" }, "revision": { "templates": ["标准线路单边", "站点"] } }
  ```

  | 键 | 必填 | 含义 |
  |---|---|---|
  | `task` | 是 | `definition-extraction`、`dataset-extraction`、`template-design` 或 `template-revision`，决定允许的候选种类 |
  | `definition` | 否 | `{name, version}`，数据集提取所选的数据定义，候选数据集必须选定它 |
  | `request` | 否 | `{template}`，出图请求的主模板，模板辅助设计时必须在候选中 |
  | `revision` | 否 | `{templates}`，模板辅助修改可以改的已保存模板 |

  `agent run` 每轮写到 `logs/outcome-context.json`，在 Agent 工作目录之外。
- **返回**：与 `check.json` 相同，只是候选不带 `sha256` 与模板修改的结构化差异 `revision`。

### 草稿预览与元素检查

- **请求**：`request` 是一份渲染请求。`mode` 只能是 `draft` 或省略，`output.format` 只能是 `png` 或省略；写了其他值会作为工具错误拒绝，不会悄悄改成草稿。
- **DPI**：上限 300，且图片最长边不超过 2000 像素。超出时自动降低，并在结果的 `requestedDpi` 里注明原值；省略 `dpi` 时取上限。
- **工作副本**（M49、M50）：`templates` 列出工作目录内的模板文件，按模板名代替已保存的同名模板，没有同名的就作为新模板加入。被调模板也先在工作副本中找。工作副本只在本次调用的内存中生效，快照不变。
- **数据集文件**：`datasetPath` 读工作目录内的数据集文件，代替 `request.dataset`，两者只能写一个。
- **局部预览**：`region` 是画板上的一块区域（毫米，相对画板左上角）。DPI 按区域大小定：区域最长边不超过 2000 像素，整图不超过 4,000 万像素。用于放大核对预览中的小字与标记。
- **元素检查**：`inspect_layout` 与草稿预览的排版一致，缺值处是占位文字。
  - `elements` 写元素路径，如 `标准线路单边/站点面板/站点列[5]/名称区/站名`；省略时从画板开始。
  - `depth` 是向下展开的层数，缺省 1；一次最多返回 300 个元素。
  - 找不到的路径会给出同名元素作为建议。

## 只读与路径限制

- **工具清单**：不存在写入、保存、发布、删除、应用或正式出图的工具，合同测试核对工具清单。
- **只读**：草稿预览与元素检查不写文件，图片以内容块返回。
- **路径限制**：读文件的工具只接受本轮工作目录内的文件，按真实路径判断。上级目录、工作目录外的绝对路径、指向外部的符号链接或目录联接，都会被拒绝；单个文件最大 32 MB。
- **宿主路径**：问题位置里的宿主机路径改写为 `工作区/…` 或 `资源仓库/…`。
- **错误分两类**：
  - 参数不合规、文件越界或不存在，作为工具错误（`isError: true`）返回，便于 Agent 自行修正；
  - 协议错误（无效 JSON、未知方法、未知工具）按 JSON-RPC 错误回复。

## 合同与版本

- **版本**：合同版本是 `0.4.0`，即 `initialize` 返回的 `serverInfo.version`。0.4.0 在 0.3.0 上新增 `check_outcome` 与 `--outcome-context`，原有工具不变（M233）。
- **兼容规则**：新增工具或可选参数属于兼容改动；改名、删参数或改变输出结构，要升合同版本并复跑评估（PRD 第 6 条）。
- **合同测试**：`test/mcp.test.ts` 用 JSON-RPC 直接驱动命令，不经模型，覆盖：
  - 协议、工具清单快照、每个工具的正常与异常输入；
  - 越界路径（含目录联接）与快照语义；
  - 工作副本不改动已保存模板；
  - 会话前后工作区、资源仓库与工作目录的文件指纹一致。

## 已知限制

- **没有识别工具（OCR）**：第三阶段 PRD 第 7 条。
- **局部放大的范围**：`view_image` 只看工作目录内的图片。预览图不落盘，要放大预览就用 `render_draft` 的 `region`。
- **资源列表很简略**：只有 ID 与种类，没有尺寸或说明。
