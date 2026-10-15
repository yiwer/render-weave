# 03: Agent 经 renderweave mcp 使用只读工具

**What to build:** Agent 或任何 MCP 客户端经 `renderweave mcp`（stdio）使用读取、校验、草稿预览、元素检查、局部放大、资源列表与 DSL 参考工具；工具合同稳定且只读。

**Blocked by:** 无

**Status:** resolved

**Trace:** 第三阶段 PRD；用户故事 19–24、34；验收 A04。

- [x] `renderweave mcp` 以本轮工作目录与只读的工作区快照启动，实现 MCP 初始化、工具列表与工具调用。
- [x] 读取工具：工作区文档的列表与内容、资源列表。
- [x] 校验工具：数据定义（按顺序在内存中发布）、数据集、模板静态检查；问题都带位置。
- [x] 草稿预览：支持已保存模板、用工作副本替代（M50）、内联数据集；返回图片内容块与问题清单。模式固定为草稿，DPI 有上限。
- [x] 元素检查：按元素路径返回布局摘要，包括位置、尺寸、字号、压缩比与是否溢出。
- [x] 局部放大：按像素区域裁切工作目录内的图片并放大，同时返回原图尺寸。
- [x] DSL 参考工具：返回 `agent/reference/` 与 `schemas/` 的内容。
- [x] 合同测试：
  - 工具清单与输入 Schema 的快照；
  - 每个工具的正常与异常输入；
  - 越界路径被拒绝；
  - 不存在写入、发布、删除与正式出图的途径；
  - 工作副本预览不改动已保存模板。
- [x] 验证脚本 `scripts/m190/` 改用本服务，M190 的 loop 步骤（埋点标记）复测通过。

**测试接缝：** 用 JSON-RPC 客户端直接驱动 `renderweave mcp`，不经模型；断言工具输出，并确认文件系统没有变化。

## Answer

2026-10-14 已完成。

**成果**

- **命令**：`renderweave mcp --workspace --resources --root [--tools] [--log]`，实现在 `src/mcp/`：
  - `server.ts`：协议层，stdio 上按行分隔的 JSON-RPC，支持 initialize、tools/list、tools/call、ping；
  - `tools.ts`：10 个工具；
  - `files.ts`：工作目录路径限制。

  工作区在启动时读入为快照。说明见 [docs/mcp.md](../../../docs/mcp.md)，决定见 M225。
- **10 个只读工具**：
  - 读取：`list_documents`、`read_document`、`list_resources`；
  - 校验：`check_definitions`、`check_dataset`、`check_templates`；
  - 预览与检查：`render_draft`、`inspect_layout`；
  - 放大与参考：`view_image`、`dsl_reference`。
- **草稿预览**：
  - 工作副本以 `templates` 文件路径传入，按模板名代替或新增；数据集可以内联，也可以用 `datasetPath` 读工作目录内的文件；
  - `mode` 只能是 draft、`format` 只能是 png，其他值作为工具错误拒绝；
  - DPI 上限 300，最长边不超过 2000 像素。
- **局部预览**：`render_draft` 另有 `region`（毫米），按区域大小提高 DPI。这是为用户故事 22 加的：预览图不落盘，`view_image` 放大不了它。
- **合同版本**：`0.3.0`，即 `serverInfo.version`。
- **预重构**：资源仓库接口加了 `list()`。
- **验证脚本**：`scripts/m190/run.mjs` 改为启动 `dist/bin.js mcp`，一次性的 `mcp-server.mjs` 已删除。模板步骤的工作区改为快照（Agent 工作目录之外），模板写在 `candidates/`，以工作副本预览；评估时把快照与候选合成评估用工作区。

**合同测试**（`test/mcp.test.ts`，19 项；客户端在 `test/support/mcp-client.ts`，经 `runCli` 驱动，不经模型）

- **协议**：协议版本协商；工具清单与输入 Schema 快照（`test/snapshots/mcp-tools.json`）；ping；无效 JSON、非 JSON-RPC 请求、未知方法、未知工具的错误码；每个工具收到未知参数都作为工具错误拒绝。
- **只读**：
  - 工具名恰为 10 个读取类工具，没有写入、保存、发布、删除、应用或正式出图；
  - `render_draft` 与 `inspect_layout` 拒绝 `mode: final`，`render_draft` 拒绝 jpg；
  - 会话前后，M402 工作区、资源仓库、工作目录与外部目录的文件指纹一致。
- **各工具的正常与异常输入**：
  - 读取：文档列表与原文；内置定义的编译产物；找不到的文档；
  - 数据定义：版本接在快照之后；写死的版本不符；文件不存在；
  - 数据集：字段路径 `stops[3].name` 类型错；候选定义下的约束违反；找不到定义；
  - 模板：工作副本插槽拼错报在 `站点/名称区/站名`；非模板文件；工作副本重名；
  - 预览与检查：
    - 草稿 PNG 尺寸；DPI 降低与 `requestedDpi`；省略 DPI；尺寸超范围的草稿仍出图；
    - 内联数据集、数据集文件两种写法出图一致，两者同写则报错；
    - 局部预览的区域、DPI 与像素尺寸；
    - 元素检查返回字号、压缩比与是否溢出；找不到的路径给出建议；
  - 放大与参考：`view_image` 裁切越界时按边界裁、整图、非图片；`dsl_reference` 七个名称都与仓库文件逐字一致。
- **路径限制**：上级目录、工作目录外的绝对路径、指向外部的目录联接都被拒绝；不存在的文件、目录也报错。三类读文件的工具都覆盖。
- **工作副本**：调用方预览中出现被调模板的修改；之后不带工作副本的预览与之前逐字节相同；快照中的模板原文不变。
- **快照与命令行**：启动后删除工作区文件，列表不变；`--tools` 只开放列出的工具；缺少参数、目录不存在、工具名写错，退出码都是 2；`--log` 每次调用一行。
- **能否变红已验证**：
  - 临时去掉真实路径的越界判断，目录联接用例立即失败；
  - 临时让工作副本写回快照，工作副本与 DPI 两个用例失败；
  - 两处都已恢复。

**M190 复测**（`node scripts/m190/run.mjs out/m190-t03 --steps loop`，qwen3.8-max）

- loop 四项判定全部通过：读了示例图、调用了 `render_draft`、从预览图读出埋点站名"七星瓢虫站"与票价 7 元。
- 服务状态 `rw:connected`，4 轮，164 s；`render_draft` 一次 455 ms。
- 另跑了一次模板步骤（通用指南 + 线路牌约定），验证快照加工作副本的流程，详见[验证记录](../../../docs/agent-validation.md#改用正式服务后的复测票据-03)：
  - 5 个模板出图 0 问题，相似度 0.885；地标底线、道路名同间隔两项通过；压测 9/10；
  - 18 次预览全部带工作副本，还用了 `check_templates`、`inspect_layout` 与 `datasetPath`；
  - 用满了 60 轮上限，交给票据 08 调整。
- 两次复测的产物共 96 个文件，搜索 key 0 命中。

**验证**：`npm test` 34 个文件 / 678 项通过（本票新增 19 项）；`npm run typecheck`、`npm run build` 通过。

**偏差与说明**

- **工具外部行为有两处变化**，评估在票据 08 迁移时一并复跑：
  - `check_dataset` 的参数由 `datasetPath` 改名为 `path`；
  - 模板步骤的输入位置改了。
- 没有做识别工具（PRD 第 7 条）。
