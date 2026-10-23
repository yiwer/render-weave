# MCP 只读工具服务

`renderweave mcp` 是交给业务 Agent 的工具服务，任何 MCP 客户端也都能用。它在标准输入输出上收发按行分隔的 JSON-RPC 2.0（MCP 的 stdio 传输），提供读取、校验、草稿预览、元素检查、局部放大、资源列表、DSL 参考与交回前核对成果。

所有工具都只读（M53）。Agent 的成果以文件形式写在本轮工作目录里，经人审核后才能应用（ADR-0015）。决定记录见 M225，交回前核对见 M233，查看资源图片见 M234。

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
| `--reference-bundle` | 可选，操作者提供的完整 `renderweave-reference-materials/1` 固定资料；受管轮次由宿主生成。启动时读入全部七份公开参考/Schema，缺少任何一份拒绝启动，之后文件变化不改变本会话资料。不给时仍从原仓库路径一次读入 |

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
| `read_document` | `kind`：`definition`、`compiled`、`template` 或 `dataset`；另写 `name`、`version` 或 `id`；`pointer` 可选 | 文档 JSON 原文，写 `pointer`（JSON Pointer）时只取一段。内置数据定义可以按 `compiled` 读 |
| `list_resources` | 无 | 资源 ID 与种类；字体另有 `weight` 与 `scripts`（能显示的文字种类），读不了的字体带 `error` |
| `check_definitions` | `paths`（按顺序，被引用的在前）、`includeCompiled` | 每个文件将发布成的名称与版本、带位置的问题。版本号接在快照中同名定义之后 |
| `check_dataset` | `path`、`definitionPaths` | 按所选定义的编译产物校验，问题带字段路径。定义可以来自快照，也可以来自候选 |
| `check_templates` | `paths` | 模板工作副本的静态检查，问题带元素路径，同一问题只报一次 |
| `render_draft` | `request`、`templates`、`datasetPath`、`region` | 问题清单与 PNG 图片内容块 |
| `compare_reference` | 可选 `templates`、`regions`、`regionOffset`（与 `regions` 互斥） | 固定参考与请求下的多维偏差、覆盖范围、源模板/实例位置、可分页区域目录、同尺度局部图；详见[视觉反馈](agent-visual-feedback.md) |
| `inspect_layout` | `request`、`templates`、`datasetPath`、`elements`、`depth` | 元素的布局摘要与这些元素上的问题 |
| `view_image` | `path`（工作目录内的图片，或 `res:资源ID`）、`region`（像素）、`scale`（1–4） | 原图尺寸、裁切区域、倍数与缩放后的 PNG |
| `dsl_reference` | `name`、`pointer`（只用于 `schema/*`） | `agent/reference/` 中的参考，或 `schemas/` 中的 JSON Schema 原文；Schema 超过 30,000 字符且不带 `pointer` 时返回目录 |
| `outcome_feedback` | `reportId`、可选 `offset`（默认0）、`limit`（1–100，默认30）、`groupBy`（code/target，默认code） | 续取同一检查的完整局部问题、差异、实例/源模板位置及未知项；分页不重检、不保存检查点；详见[资料策略](agent-context-policy.md) |
| `check_outcome` | 无 | 按交回后的同一套规则核对工作目录根上的 `outcome.json` 与候选：结论 `verdict`、`outcome.json` 的问题，以及每个候选的问题与 `deferred`；模板辅助修改另有 `revision` 范围摘要 |

工具结果是一段 JSON 文本，预览类工具再加一个图片内容块。`tools/list` 给每个工具标注 `annotations: { readOnlyHint: true, openWorldHint: false }`。

### 文字结果的上限

Claude Code 把超过 50,000 字符的工具文字结果转存成文件，只给模型约 2,000 字符的预览；模型要另外读那个文件，读不读取决于模型（M289）。所以每个工具的文字结果都控制在 40,000 字符以内（票据 22）：

- **问题清单**：`render_draft`、`inspect_layout`、`check_*` 与 `list_documents` 最多列 200 条、约 25,000 字符。截断时另有 `problemsTruncated`：已列条数、总数与按问题代码的计数（`check_outcome` 的 `deferred` 同样有 `deferredTruncated`）。
- **元素检查**：`inspect_layout` 按约 30,000 字符的预算收集元素，用完时返回 `truncated: true`、`returned`（已返回）与 `total`（这次请求范围内的元素总数）。
- **模板修改差异**：`check_outcome` 的每个候选最多返回 100 条差异、约 20,000 字符，只列范围。截断时 `revision` 中另给 `truncated: true` 与 `total`（该候选的差异总条数），已返回条数是 `changes.length`。
- **局部问题续取**：`check_outcome.feedback.reportId` 对应本会话最近一次完整检查；`outcome_feedback` 按 `nextOffset` 取完所有页，保留问题代码、目标与原始上下文，未知项单独计数。单项过大时按 `itemId/index` 拼接 JSON 分片。修改后重新检查，下一次检查使旧报告失效；详见[分页语义](agent-context-policy.md#完整问题的分页)。
- **Schema**：`dsl_reference` 的 `schema/*` 可以写 `pointer`（JSON Pointer，如 `/$defs/textElement`）只取一段；整份超过 30,000 字符的（目前只有 `schema/template`）不带 `pointer` 时返回目录：顶层各键，以及 `properties`、`$defs` 中各项的字符数。`pointer` 找不到时是工具错误，列出那一层可用的名称。`read_document` 也可以写 `pointer`。
- **兜底**：工具结果仍超过 40,000 字符时，服务层不交出，改为工具错误，提示缩小范围。
- **观测**：调用日志每条记 `chars`（文字结果字符数）与 `imageBytes`（图片字节数）；评估报告统计被转存或拒收的工具结果（`persistedResults`），非零时在文字摘要里提示。

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
  | `request` | 否 | 完整出图请求，模板辅助设计的主模板必须在候选中；兼容旧的 `{template}`，但只能静态检查 |
  | `revision` | 否 | `{templates}`，模板辅助修改可以改的已保存模板 |
  | `briefText` | 否 | 项目说明原文；留作上下文，不用关键词匹配授权固定常量 |
  | `contentBaseline` | 否 | 宿主核准的本次内容事实；由 `agent run --content-baseline` 提供，领域名称不产生事实 |
  | `baseline` | 否 | 人工核准的原图区域、画板尺寸及测量类型；由 `agent run --reference` 固定 |
  | `referenceImage` | 否 | `{path, sha256}`，宿主原图快照；比较前校验实际字节与核准尺寸 |
  | `resourceIdentity` | 否 | `agent run` 生成的固定资源身份清单：ID、种类、原版本或旧目录映射、字节 SHA-256 与长度；工具只将实际依赖计入检查身份 |

  `agent run` 每轮写到 `logs/outcome-context.json`，在 Agent 工作目录之外。
- **成果评估（合同 0.9.0，M294）**：返回 `assessment.structure`、`candidates`、`content: needsReview` 与 `render`。渲染包含 `status`（`notChecked` / `renderable` / `blocked`）、`hasImage`、`capabilityBlocked`、`blocking` 和按预算截断的问题清单。有完整请求时覆盖候选做实际草稿渲染；模板存在严重出图问题时 `verdict` 为 `unqualified`。已知能力受阻应保留候选和说明后交回，严重问题仍阻止审核通过与应用。
  - 提取任务的 `assessment.coverage`：本次可信事实的严重异常、已覆盖/缺失/未知项；未校准总分为 `null`，严重异常使 `verdict` 为 `unqualified`。没有基准时为 `notChecked`。完整 `coverageVerification` 由宿主保存到 `check.json`。
  - 模板任务的 `assessment.visual`：与 `compare_reference` 相同的报告 ID、区域偏差和覆盖摘要；兼容 `assessment.style`。没有基准或尺度未对齐记 `notChecked`；异常只记提示。完整 `styleVerification` 由宿主保存，工具只返回限长摘要。
- **返回**：与 `check.json` 使用同一份校验结果，候选不带 `sha256`，问题清单按上述预算截断。有 `revision` 上下文时，模板候选另给结构化差异的范围摘要（M293），其他任务不返回：
  - `revision.status`：`modified`（改了已保存模板）、`unchanged`（原样，应用时不写入）或 `added`（新模板）。后两者的 `changes` 是空列表。
  - `revision.changes`：每条有 `path`、`target`（`element` / `template`）、`change`（`added` / `removed` / `changed`）；有属性差异时，`properties` 是属性键名数组，如 `["color", "place"]`。参数、派生变量与检查项用各项的名称。没有 `before` / `after`，新增、删除元素也不返回元素正文。
  - Agent 可对照修改要求核对范围；这不改变校验结论，不自动判断是否满足修改要求，仍由审核人决定。审核页与 `check.json` 保留完整差异。

### 查看资源图片

`view_image` 的 `path` 写 `res:资源ID` 时，看资源仓库中的图片资源，用于把示例图上的图标、标记与资源图片对照后再引用（M234）。

- **读法**：只经资源仓库接口按资源 ID 读，与出图用的是同一份内容；版本仓库取服务启动时的当前版本。`res:` 后面只能是资源 ID，不能写资源仓库里的路径。
- **格式**：PNG、JPEG、WebP 与 SVG。SVG 的原图尺寸是它的像素尺寸（96 DPI），按放大后的尺寸栅格化。
- **区域与输出**：与工作目录内的图片相同。

### 看图的倍数

`view_image` 的输出最长边不超过 1,400 像素。缺省最多放大 2 倍；写 `scale`（1–4）时按它放大，仍受 1,400 像素约束；越界是参数不合规（票据 19）。

- **原因**：模型按输出像素计图片 token。366 的 8 条竖带实测，原分辨率、2 倍与原来的 2.69 倍站名都是 59/59，图片 token 约为 3.5k、10.9k 与 18.9k（[二次复核](agent-tooling-evaluation.md#实测-1看图的倍数与拼图)）。
- 把多块区域拼成一张图的做法实测会掉转录准确率，不提供。
- **错误**：资源 ID 不存在、是字体资源、写法不对，或内容不是受支持的图片，都作为工具错误返回。

### 草稿预览与元素检查

- **请求**：`request` 是一份渲染请求。`mode` 写 `final` 时也按草稿出图，结果注明 `modeDowngraded: true`：Agent 照抄 `docs/request.json` 时那份请求带着 `final`（票据 22）。`mode` 的其他值、`output.format` 不是 `png` 时作为工具错误拒绝。
- **DPI**：上限 300，且图片最长边不超过 2000 像素。超出时自动降低，并在结果的 `requestedDpi` 里注明原值；省略 `dpi` 时取上限。
- **工作副本**（M49、M50）：`templates` 列出工作目录内的模板文件，按模板名代替已保存的同名模板，没有同名的就作为新模板加入。被调模板也先在工作副本中找。工作副本只在本次调用的内存中生效，快照不变。
- **数据集文件**：`datasetPath` 读工作目录内的数据集文件，代替 `request.dataset`，两者只能写一个。
- **局部预览**：`region` 是画板上的一块区域（毫米，相对画板左上角）。DPI 按区域大小定：区域最长边不超过 2000 像素，整图不超过 4,000 万像素。用于放大核对预览中的小字与标记。
- **元素检查**：`inspect_layout` 与草稿预览的排版一致，缺值处是占位文字。
  - `elements` 写元素路径，如 `标准线路单边/站点面板/站点列[5]/名称区/站名`；省略时从画板开始。
  - `depth` 是向下展开的层数，缺省 1；一次最多返回 300 个元素、约 30,000 字符，超出时见[文字结果的上限](#文字结果的上限)。
  - 找不到的路径会给出同名元素作为建议。

## 只读与路径限制

- **工具清单**：不存在写入、保存、发布、删除、应用或正式出图的工具，合同测试核对工具清单。
- **只读**：草稿预览与元素检查不写文件，图片以内容块返回。
- **路径限制**：读文件的工具只接受本轮工作目录内的文件，按真实路径判断。上级目录、工作目录外的绝对路径、指向外部的符号链接或目录联接，都会被拒绝；单个文件最大 32 MB。`view_image` 的 `res:资源ID` 不是路径，只按 ID 经资源仓库接口读。
- **宿主路径**：问题位置里的宿主机路径改写为 `工作区/…` 或 `资源仓库/…`。
- **错误分两类**：
  - 参数不合规、文件越界或不存在，作为工具错误（`isError: true`）返回，便于 Agent 自行修正；
  - 协议错误（无效 JSON、未知方法、未知工具）按 JSON-RPC 错误回复。

## 合同与版本

- **版本**：合同版本是 `0.17.0`，即 `initialize` 返回的 `serverInfo.version`。
  - 0.17.0 增加有证据的停滞停止：阈值、完整反馈交付、候选修复与下一周期依据均可追溯，正常自检、交回和分页排除规则见[停滞控制](agent-stagnation.md)。工具权限与检查点格式不变。
  - 0.16.0 新增只读 `outcome_feedback` 与 `check_outcome.feedback` 续页入口，日志以检查报告ID及实际内容身份关联；公开参考在会话启动时固定。两种资料策略共用这些工具，默认全量与 effort 不变，见[资料策略](agent-context-policy.md)。
  - 0.15.0 固定本地素材/核准事实权限边界，模型上游凭据由宿主持有，运行及失败诊断持久化前脱敏；工具仍只读，版本与平台证据见[信任边界](agent-trust-boundary.md)。
  - 0.14.0 明确 Agent 整轮预算、取消、停止保存与已知用量合同；新增停止凭据及可选生效 runtime 字段，工具仍只读，见[整轮预算](agent-budgets.md)。
  - 0.13.1 的宿主工具日志为 `check_outcome` 增加实际内容身份，为 `compare_reference` 增加本页区域目录、续取位置及本页异常区域。评估可以核对后续页实际取得和末次工具检查/终检的关联；不改变候选、参考或工具只读权限。
  - 0.13.0 为受管 `check_outcome` 增加 `checkpoint` 保存完成状态、ID 与内容身份，或 `notSaved` 原因。宿主固定完整字节后检查并原子保存，MCP 工具仍只读；独立 MCP 不保存。保存不代表业务合格或人工批准，见[检查点与接续](agent-checkpoints.md)。
  - 0.12.1 将本地应用读取接入提交恢复：相关工作区未完成应用时先恢复或明确返回 `apply.recoveryRequired`，不把混合输入作为工具初始状态。Agent 新应用记录为 `renderweave-applied/2`，公开应用结果带可核对的 `commitId` 与重复结果标记，旧 `/1` 成功记录仍读取。工具参数与只读能力不变；恢复和同宿主 Windows/Linux 边界见[应用恢复](agent-tasks.md#应用强退与恢复)。
  - 0.12.0 为 `compare_reference` 和 `check_outcome` 的视觉结果增加 `contentInvisible`、`imageContentMismatch`，每个实例可返回 `visibility` 与 `imageContent`。基准新增操作者核准的 `expectedImageSha256`；实际绘制的透明、完全裁掉和有限实心矩形遮挡证据与宿主终检一致，图片按实际资源字节核对。未知不计通过，合同不承诺整体可读性或全样式验收；完整边界见[视觉反馈](agent-visual-feedback.md)。分页和总预算不变。
  - 0.11.1 将本地工作区读取、资源替换和审核应用纳入共同的短时读取/提交约束。工具初始化取得完整文档与资源字节副本后释放约束，调用期间使用同一副本；新读取才能看到后续更新。占用时本地读取可返回 `local.storeBusy`，需重试，不把部分输入当成有效工作区。工具参数及身份摘要形状不变。
  - 0.11.0 为每次 `check_outcome` 增加 `contentIdentity` 摘要（`format`、`id`、`engine`、`criteria`）。完整身份随宿主检查保存，含候选集合、依赖文档、请求、可信参考/内容事实和实际读取资源；不含模型配置。`agent run` 在启动执行器前固定资源，本轮工具与终检读取同一份私有副本；审核/应用规则见[内容身份与重新核准](agent-tasks.md#内容身份与重新核准)。工具仍只读。
  - 0.10.1 为 `compare_reference` 增加 `regionOffset` 和可分页区域目录，摘要截断后仍可发现并点查全部区域；最终检查的问题、内容明细和修改差异共享预算。
  - 0.10.0 增加 `compare_reference`、受保护的参考输入、`assessment.visual`、实际资源/构建来源；提取核查改用本次可信事实，总分为 null，未知不计通过。接入与边界见[视觉反馈](agent-visual-feedback.md)；
  - 0.9.0 在 `check_outcome` 的评估里加入提取覆盖（票据 33）与样式核查（票据 34）：新增 `assessment.coverage`、`assessment.style`、`coverageVerification`、`styleVerification`；工具输入不变；
  - 0.8.0 加入成果分层评估和指定请求的实际渲染；受阻交回与正式交付分开（票据 31，M294）；
  - 0.7.0 在 0.6.0 上让 `check_outcome` 返回模板辅助修改的差异范围摘要（票据 17，M293），工具输入与其他任务的输出不变；
  - 0.6.0 在 0.5.0 上（票据 19、22、29）：`view_image` 缺省最多放大 2 倍并新增 `scale`；`dsl_reference`、`read_document` 新增 `pointer`，`schema/template` 不带 `pointer` 时返回目录；问题清单与元素检查有上限并给出截断信息；`render_draft`、`inspect_layout` 把 `mode: "final"` 按草稿处理；`list_resources` 给字体加 `weight` 与 `scripts`；工具带 `annotations`；文字结果超过 40,000 字符时改为工具错误；
  - 0.5.0 在 0.4.0 上让 `view_image` 的 `path` 接受 `res:资源ID`，工具清单只变了 `view_image` 的说明与 `path` 描述（M234）；
  - 0.4.0 在 0.3.0 上新增 `check_outcome` 与 `--outcome-context`，原有工具不变（M233）。
- **兼容规则**：新增工具或可选参数属于兼容改动；改名、删参数或改变输出结构，要升合同版本并复跑评估（PRD 第 6 条）。
- **合同测试**：`test/mcp.test.ts` 用 JSON-RPC 直接驱动命令，不经模型，覆盖：
  - 协议、工具清单快照、每个工具的正常与异常输入；
  - 越界路径（含目录联接）与快照语义；
  - 资源图片按 ID 读取，版本仓库取当前版本；
  - 工作副本不改动已保存模板；
  - 会话前后工作区、资源仓库与工作目录的文件指纹一致；
  - 文字结果的上限、截断信息与服务层兜底。

## 已知限制

- **没有识别工具（OCR）**：第三阶段 PRD 第 7 条。
- **资源列表很简略**：图片只有 ID 与种类，没有尺寸或说明，内容要逐个用 `view_image` 看；字体的 `scripts` 是抽样判断，具体的字以草稿的缺字问题为准。
