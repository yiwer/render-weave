# 成果的交回格式

第一次写出可读候选后，就在工作目录根上写 `outcome.json`，之后每次修改都同步更新。交回前用 `check_outcome` 核对结构、候选与实际渲染；`qualified` 表示这些技术检查通过，内容与样式仍需审核。

`check_outcome` 的 `contentIdentity.id` 标识本次实际检查的候选和依据。修改候选后要重新检查，不把旧 ID 或旧图作为新候选的证据。本轮资源由宿主固定；资源更新后的重新检查与核准由操作者发起。这个身份由工具计算，不写进 Agent 的 `outcome.json`。

按 `assessment` 决定下一步：
- `structure` 或 `candidates` 为 `invalid`：按问题修正文件或引用后重新核对。
- `render.status` 为 `notChecked`：本轮缺少完整出图请求，说明未验证的范围。
- `render.capabilityBlocked` 为 `true`（例如 `text.unshapedScript`）：保留原文与候选，在 notes 中记录阻塞、已完成部分和剩余差异，交回受阻草稿并结束本轮。能力边界仍是严重问题，正式出图与审核通过继续受阻。
- 其他渲染严重问题：修正本轮可修的问题；重复同一修复没有进展时，记录尝试与剩余问题，交回草稿由人决定下一步。
- 模板任务的 `visual.status` 为 `needsWork`：按区域异常与 `sourceLocation` 修正，再调用 `compare_reference`。`notChecked` 表示未建立有效比较；`needsReview` 表示已测维度未发现差异，但仍有未测内容。`coverage` 说明核准区域和实例范围，`unknown` 列出测量边界；任何状态都不代表整图视觉合格。
- `contentInvisible` 表示核准内容因全透明、完全裁掉或后绘制的不透明实心矩形完全遮挡而不可见；按 `visibility` 的位置、原因与遮挡对象核查。工具仅判断这些有限反例，部分遮挡、复杂变换和低对比仍需看图。`imageContentMismatch` 表示实际图片字节不同于宿主核准内容，不能用相同资源名称解释为正确；缺少图片事实保持未核查，不自行改写真值。
- 提取任务的 `coverage` 只以宿主提供的本次内容基准核对。`notChecked` 表示未配置基准，未知项仍需审核；总分为 `null`。`notes`、覆盖自述与无依据的固定常量声明不能替代事实。

轮数或额度将尽时，优先更新成果清单、待确认项与 notes。中断后宿主可能抢救 `draft.json`，但其完成度未知，只能查看，不能批准或应用。

```json
{
  "candidates": ["candidates/schema-badge.json", "candidates/schema-session.json"],
  "locations": [
    { "file": "candidates/schema-badge.json", "path": "fullName", "where": "胸牌正中的大号姓名", "region": { "x": 96, "y": 410, "width": 520, "height": 120 } },
    { "file": "candidates/schema-badge.json", "path": "role", "where": "姓名下方的彩色身份色带", "region": { "x": 0, "y": 560, "width": 708, "height": 90 } },
    { "file": "candidates/schema-session.json", "path": "title", "where": "底部场次表的第一列" }
  ],
  "pending": [
    {
      "file": "candidates/schema-badge.json",
      "path": "role",
      "candidate": ["讲者", "嘉宾", "工作人员"],
      "reason": "inferred",
      "note": "示例图只出现了“讲者”，其余身份是按会务常见分类推测的"
    },
    {
      "file": "candidates/schema-badge.json",
      "path": "seat",
      "reason": "unreadable",
      "note": "座位号区域印得很淡，放大后仍无法确认是否每张胸牌都有"
    }
  ],
  "notes": "关键取舍：……；仍有的差异：……"
}
```

## 键

| 键 | 必填 | 写法 |
|---|---|---|
| `candidates` | 是 | 候选文件路径的列表，至少一项，不能重复。文件必须放在 `candidates/` 下，是 `.json` 文件，种类要符合任务：数据定义提取只交数据定义，数据集提取只交数据集，模板辅助设计与模板辅助修改只交模板。模板辅助修改只列改过的模板与新建的模板，见下文 |
| `locations` | 否 | 字段、值或元素在示例图上的位置，见下文 |
| `pending` | 是 | 待确认项列表，没有就写 `[]` |
| `notes` | 是 | 给审核人的说明：关键取舍的理由、仍有的差异 |
| `coverage` | 否 | 业务内容覆盖记录：逐项说明图上的内容归到字段、派生、参数、固定标签还是待确认。数据定义提取与数据集提取建议写全，见下文 |

不能有其他键。

## 位置的写法

`locations` 与 `pending` 都用 `file` 加 `path` 指向候选文件中的一个位置，省略 `path` 表示整份文件：

| 候选种类 | `path` 的写法 | 例子 |
|---|---|---|
| 数据定义 | 字段名，必须存在于该定义中 | `role` |
| 数据集 | `data` 中的字段路径，列表序号从 1 开始；最后一段可以是还没有值的字段 | `sessions[2].title` |
| 模板 | 元素路径，用 / 分隔，不带序号；可以从模板名开始，也可以省略模板名。被调模板里的元素，`file` 写被调模板的文件，`path` 写元素在被调模板里的路径 | `姓名区/姓名` 或 `胸牌/姓名区/姓名` |

待确认项的位置必须能在文件中找到，否则成果不合格；图上位置对不上时只记提示。

```json
{
  "pending": [
    { "file": "candidates/dataset-badge.json", "path": "sessions[2].title", "candidate": "开幕式", "reason": "unreadable", "note": "第二场场次名称被挂绳遮住一半，按可见笔画推断" },
    { "file": "candidates/template-badge.json", "path": "胸牌/姓名区/姓名", "candidate": "res:font-hei-bold", "reason": "inferred", "note": "示例图的姓名字体无法确认，用了黑体粗体" }
  ]
}
```

## 模板辅助修改

`candidates/` 中预先放着可以修改的已保存模板，文件名与工作区相同。直接修改这些文件；与已保存模板同名的就是它的工作副本，应用时替换已保存的模板。

- `candidates` 只列改过的模板文件与新建的模板文件。没改的不用列；列了也只记提示，应用时不写入。
- 新建的被调模板另起文件，名称不能与工作区已有的模板重复。
- 预先放进来的模板以外，工作区中已保存的模板不能改。
- RenderWeave 会对比工作副本与已保存的模板，给审核人看结构化差异与修改前后的预览，不需要在说明里抄写改动的内容。

## 图上位置

审核人要对照示例图逐个核对。图上能看到的字段（数据集中的值、模板中的主要元素），每个写一项 `locations`，说明它对应图上的哪一部分；图上看不到的（如推测出的、只在业务中存在的）不写。数据集中的长列表只写有代表性的几项。

| 键 | 必填 | 写法 |
|---|---|---|
| `file` | 是 | 指向 `candidates` 中的一个文件 |
| `path` | 否 | 位置，写法见上文；省略时表示整份文件 |
| `where` | 是 | 文字描述，如"顶部左侧的大号编号" |
| `region` | 否 | 示例图上的像素区域 `{ "x", "y", "width", "height" }`，左上角为原点，写法与 `view_image` 的 `region` 相同。先用 `view_image` 放大核对再写；字段在图上出现多处时，框住最有代表性的一处 |

## 待确认项

拿不准的值都列为待确认项，由人逐项处理。不要猜一个值当作确定的值交回。

| 键 | 必填 | 写法 |
|---|---|---|
| `file` | 是 | 指向 `candidates` 中的一个文件 |
| `path` | 否 | 位置，写法见上文；省略时表示整份文件 |
| `candidate` | 否 | 候选值，任意 JSON；没有就省略。数据集中写这个位置的候选值：草稿预览先用它，审核人采纳时也用它。数据定义与模板中写给审核人的建议 |
| `reason` | 是 | 原因，四选一，见下表 |
| `note` | 是 | 说明为什么拿不准、依据是什么 |

| `reason` | 含义 |
|---|---|
| `unreadable` | 看不清：放大后仍无法辨认 |
| `inferred` | 推测：图上没有直接给出，按常识或上下文推断 |
| `conflicting` | 来源冲突：图上不同位置、或图与项目说明给出的信息互相矛盾 |
| `requiredMissing` | 必填未提供：必填的信息在素材中找不到 |

可选字段没有值，不算待确认项。

## 完整检查点

受管轮次中，`check_outcome` 返回 `checkpoint.status: "saved"`、`id` 和 `contentIdentity` 才表示宿主已保存这次完整检查实际读取的集合。候选应先全部写好，再显式检查；单文件写完、预览或旧检查结果都不会保存新的完整集合。`notSaved` 会说明半写、缺依赖或读取期间变化等原因。

保存与质量分开：结构完整但业务不合格可以留存，仍须修复或交回说明；保存不会批准或应用。检查后继续编辑会产生新工作副本，要再次完成整组检查才能更新检查点。工具仍只读，保存由宿主执行。

宿主分别保留最后完整集合和有证据更好的集合。首次保存只是比较起点；只有同一依据下核准指标改善、其余维度不退步且不增加未知时才更新较好集合。哈希变化、自述进步和错误转为待确认均不是改善证据。相对改善仍可能有业务受阻或未核查范围。最终交回始终取你明确提交的整套内容；宿主不会用较早候选暗换正式稿。

## 业务内容覆盖

数据定义提取与数据集提取在交回时用 `coverage` 交代图上的业务内容去了哪里。RenderWeave 依据宿主核准的本次事实核对对应字段、缺值和具体数值；严重异常会让 `check_outcome` 不合格。没有事实基准的项目、派生关系与计算依据仍需人工核实，不能用自述代替。

| 键 | 必填 | 写法 |
|---|---|---|
| `id` | 是 | 稳定标识，如 `routeNo`、`stopCode`、`minutesFromStart` |
| `label` | 是 | 图上或业务中的名称 |
| `kind` | 是 | `field`（字段）、`derived`（派生）、`parameter`（出图参数）、`constant`（固定标签）或 `pending`（待确认） |
| `file`、`path` | 否 | 对应的候选与位置 |
| `isOptional` | 否 | 该字段在数据定义中是否可选 |
| `derivedFrom`、`logic` | 派生时 | 依赖的字段与计算依据，如 `["totalMinutes","remainingMinutes"]` 与 `55-31=24` |
| `justification` | 固定标签时 | 项目说明中的依据；没有依据就不要归为固定标签 |
| `sampleOmissions` | 否 | 示例图上有多少处缺值，如站码 15 处 |
| `notes` | 否 | 来源区域、图上读法或其他说明 |

- 图上直接读到的值归 `field`；由其他值算出的归 `derived` 并写清依据；本站序号一类出图时传入的归 `parameter`。
- 图上没有出现、项目说明也没授权的内容，不要写成 `constant`；可以不列。
- 看不清、推测或来源冲突的值同时写进 `pending`；`inferred` 的说明里要有计算或判断依据。
- 已知缺值（如 15 个站缺编号）在 `sampleOmissions` 或 `pending` 中说明，不能无说明放过。
