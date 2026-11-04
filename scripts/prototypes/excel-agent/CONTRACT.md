# staticSchema 驱动的 Excel 任务工具（原型 v2）

启动时必须指定工作空间、已发布 staticSchema 的准确 `name@version`、xlsx 原件与项目说明。宿主固定工作空间快照、目标定义及其编译产物；目标由用户/调用者选择，模型不能修改。无定义、重复身份或未发布时启动失败。

模型只获得以下任务工具，没有宿主 Bash 或任意文件访问：

| 工具 | 参数 | 返回 |
|---|---|---|
| `inspect_workbook` | 无 | 源哈希、工作表名称/范围/合并关系/隐藏状态、读取问题 |
| `read_region` | `sheet`、`range`，可选 `offset`、`pageSize`（1–100） | 带坐标的原始值、显示状态与分页位置 |
| `read_schema` | 无 | 固定的 staticSchema 引用、DSL 原文及编译产物；引用定义的发布版本一并提供 |
| `submit_transform` | `plan` 对象、`script` Python 文本（最多 64 KB） | 不可覆盖的尝试编号、执行状态、独立来源检查、全部候选的引擎检查；失败返回具体位置 |
| `finish` | `attemptId`、`notes`、`pending` 字符串列表 | 仅机械与引擎均通过的已固定候选可交回；仍为语义待审、不可自动应用 |

工具错误可在同一 Claude 会话中修复；所有请求、错误和尝试保留。宿主最多接收 6 次转换，整轮默认 10 分钟、最多 24 个模型轮次。上游 key 仅在模型代理宿主内存中，执行器只持有本轮代理令牌；脚本容器无二者。

## 通用计划

```json
{
  "format": "rw-excel-plan/2",
  "sourceHash": "inspect_workbook 返回的 sha256",
  "definition": {"name": "调用者选定的定义", "version": 1},
  "datasets": [{"id": "新数据集身份", "value": {"op": "object", "fields": {}}}],
  "context": [{"sheet": "sheet-1", "range": "A1:C1", "reason": "表头，需审核分类理由"}]
}
```

`value` 是递归节点，字段名称来自 staticSchema。根节点必须输出对象。节点与字段层级无任何公交约定：

- `object`：`fields` 为字段名到节点的映射。可选字段的源值为空时，节点写 `omitIfEmpty: true`；不凭空补默认值。
- `array`：`items` 为有序节点数组。
- `rows`：`start`、`end` 为包含端点的行号，`index` 为行变量名（缺省 `row`），`item` 为每行节点。嵌套 rows 变量不能遮蔽外层变量。
- `cell`：`sheet`、`cell`，例如 `B{row}`；从一个源位置取值。
- `comment`：`sheet`、`cell`，例如 `F{row}`；读取该格的传统批注原文，仅支持缺省 `as: "display"`。不是单元格正文；富文本的文字、换行、首尾空格与作者前缀照原文保留。可选批注不存在时使用 `omitIfEmpty: true`；已经存在但内容为空的批注仍输出空字符串及来源。
- `collect`：`sheet`、`cells` 坐标列表；跳过空值，保留顺序和重复值。
- `split`：`sheet`、`cell`、`separators` 明确分隔符列表；去掉每项首尾空白和空项，保留顺序和重复值。

叶节点 `as` 默认 `display`；`number` 必须来自数值单元格；`boolean` 接受原生布尔，文本需显式 `values` 对照，例如 `{"是":true,"否":false}`；`date` 接受 ISO 日期文本或 `yyyy-mm-dd` / `yyyy/m/d` 格式的整数日期序列并转为 ISO。公式缓存、错误值、未知显示格式均不静默采用。未支持的派生计算应列待确认，不能声明已经独立核对。

`context` 给非数据区域列理由，不能与已提取位置冲突。未分类的非空单元格会报错。分类本身、字段业务含义与单位仍需审核；机械检查不能认证一个自洽但错误的映射。

批注单独分类，正文的 `context` 不覆盖批注。未映射批注使用顶层 `commentContext: [{"sheet":"sheet-1","cell":"B2","reason":"明确的未映射理由"}]`，不支持范围一键忽略；与已提取批注冲突、漏批注、重复分类均失败。模型不能把制作要求当作可忽略的格式。没有目标字段时明确待审，不改变 staticSchema。

`inspect_workbook` 返回每张表的 `commentCount`、`commentCells`；批注可能附在空格或正文范围外，按列出的坐标调用 `read_region`。区域分页的 `comments[]` 只含本页坐标上的批注；记录包含 `cell`、`text`、`author`、`part`，以及存在且核对过的 `vml`（部件、图形身份、零基 row/column、显示框 anchor 八项和可见性）。VML 的目标行列与显示框位置是两回事，不据显示框推断所属站点。未知绘图、图片、控件及未支持部件仍报错，禁止删除或规避。

## 脚本输入和输出

容器当前目录 `input.json` 为 `{"view": <固定完整视图>, "plan": <本次计划>}`。`view.sheets[]` 有 `id`、`cells[]`、`comments[]`，每个 cell 有 `address`、`kind`、`raw`、`value`、`numberFormat`、`display`、`displayStatus`；公式单元格另有 `formula`。批注来自 `sheet.comments`，不是 `cell.comment`。脚本使用 Python 标准库，写一个 `candidate.json`，不要在 stdout 打印日志或 JSON。

```json
{
  "datasets": [{"dataset":{"id":"新数据集身份","staticSchema":{"name":"选定定义","version":1}},"data":{}}],
  "sources": [{"datasetId":"新数据集身份","path":"/字段名/0/子字段","sheet":"sheet-1","cells":["B2"],"rule":"cell"}]
}
```

来源路径使用 JSON Pointer，数组从 0 开始，`~` 与 `/` 分别转义为 `~0`、`~1`。每个实际输出的叶节点一条来源；`collect` / `split` 列表整体一条，`rows` / `object` / `array` 无单独来源。cells 只列非空源坐标，split 仍列原单元格一次；省略可选字段不写来源。

`comment` 的来源形状是 `{"datasetId":"...","path":"/stops/0/sizeComment","sheet":"sheet-1","cells":["F5"],"rule":"comment","parts":["xl/comments1.xml"]}`。`parts` 必须等于所读批注的 `part`，不能填写 VML 或自己猜部件；批注即使附在空单元格或文字为空仍保留此来源。宿主从原件独立核对原文与部件，审核页展示原文、作者、锚点和目标字段或未映射理由。

宿主从固定 view 和计划独立重算，逐值、逐类型、逐顺序、逐来源核对；再通过工作空间快照中的 staticSchemas 校验所有候选。任意字段和引用类型能否取值由输入和转换能力决定，不宣称支持所有 Excel 表式或所有派生函数。

`--inject-list-truncation` 专用于修复测试：宿主在第一次提交的脚本后追加一个显式记录的缺陷（截断首个非空列表），保留原脚本和实际执行脚本，并把检查反馈及实际脚本回给模型。该失败归因于宿主注入，不能计作模型天然错误，也不能把随后成功当作真实客户通过。
