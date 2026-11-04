# 从已应用数据集准备渲染项并交付

P06 增加 `agent prepare-output` 与 `agent deliver-output`。前者核对已经审核应用的数据、生成标准批次请求并固定依赖；后者使用固定快照交付图片。输入仍来自工作空间 staticSchema，模板和对外参数决定如何出图，代码不包含线路、站点或商品字段分支。

实现位于 `feature/excel-agent-p06`，工作树 `F:\GenCode\render-weave-excel-prototype`；主检出同步文档。前置流程见[提取与审核](excel-agent-review.md)，实例与边界见[P06 报告](agent-eval/excel-agent-p06.md)。

## 1. 准备数据与版本资源仓库

数据集须先经过 `agent review` 和 `agent apply`。准备时会核对本轮全部候选在当前工作空间中的内容，以及固定 staticSchema 的定义和编译产物；应用后改过数据或定义就拒绝，需要重新审核。模板可以在数据应用后加入工作空间，但必须接受这些数据集的定义。

正式交付使用版本资源仓库。示例准备方法（每次创建新目录）：

```powershell
npm run build
node dist/bin.js resources-init --resources out/my-output-resources
node dist/bin.js resources-import --source fixtures/resources --resources out/my-output-resources
```

## 2. 写明确的出图计划

以下例子对本轮全部数据集各出一张价签：

```json
{
  "format": "renderweave-output-plan/1",
  "mode": "final",
  "groups": [{
    "id": "shelf",
    "template": "商品价签",
    "datasets": "all",
    "parameters": { "storeName": "示例生活超市" },
    "output": { "width": 100, "height": 50, "dpi": 120, "format": "png" }
  }]
}
```

| 配置 | 含义 |
|---|---|
| `mode` | 全计划统一为 `final` 或 `draft`；必须明确填写 |
| `groups` | 1–20 个组；组 ID 唯一，各组可选择不同模板、尺寸与参数 |
| `datasets` | `"all"` 选择本轮应用且未全局跳过的全部数据集；也可明确列出 ID 数组 |
| `parameters` | 模板对外参数的常量取值；类型、约束和内部参数边界由引擎校验 |
| `output` | 毫米宽高、DPI、PNG/JPEG；须符合模板尺寸范围和引擎像素限制 |
| `skipped` | 顶层数组，每项 `{ "datasetId", "reason" }`；说明本次不出图的数据集 |

全部应用候选必须被至少一个组选择或明确跳过；不能默默遗漏。一个数据集可进入多个组，例如同时出普通和大号价签；这会产生多张图片。`all` 自动排除顶层跳过项，显式 ID 列表与跳过声明冲突则报错。

多尺寸、两种图片格式及跳过的完整例子：[price-tags-plan.json](../fixtures/excel/output/price-tags-plan.json)。

## 3. 按任意列表位置出图

在组中增加 `forEach`，把列表原始位置传给模板对外数值参数：

```json
"forEach": {
  "path": "/batches/0/items",
  "parameter": "productIndex",
  "indexBase": 1,
  "skip": [{ "index": 2, "reason": "第三项不在本次制作范围" }]
}
```

`path` 是相对数据集 `data` 的 JSON Pointer，支持嵌套路径；`parameter` 必须是模板声明的对外数值参数。`indexBase` 明确指定输出参数从 0 或 1 开始；`skip.index` 始终是原列表的 **0-based** 位置，并且对该组选中的每个数据集生效。

跳过第三项后，1-based 参数仍为 `1、2、4、5、6`。同名、重复值仍按位置分别出图，不按字段值去重。列表为空、路径不存在、跳过越界或位置参数同时有常量赋值都会拒绝准备。不同数据集需要不同跳过规则时拆成多个组。

例子：[catalog-plan.json](../fixtures/excel/output/catalog-plan.json) 配合[目录商品卡模板](../fixtures/excel/output/template-catalog-item.json)。模板自身用 `pickItem` 解释位置参数；系统不推测模板使用 0-based 还是 1-based。当前一次迭代选择一个明确列表路径，不执行脚本、跨表关联或通配符展开。

## 4. 准备并检查

保存计划为 `out/output-plan.json` 后执行：

```powershell
node dist/bin.js agent prepare-output --round out/my-review-02 --resources out/my-output-resources --plan out/output-plan.json --out out/my-prepared
```

可加 `--options <字体配置.json>`，与既有交付选项相同。输出目录必须不存在；错误不覆盖旧成果。

准备成功返回 `state: prepared`、渲染项数、跳过数和批次数。目录包括 `plan.json`、逐组的 `request-001.json` 等标准批次请求、固定批次快照、实际资源副本及 `prepared.json`。核对每组模板、数据集、参数、尺寸和跳过原因后再执行交付。准备不进行排版绘制，字体适配和版面问题仍可能在交付阶段失败。

上限为 20 组、合计 1000 个展开位置（含逐项跳过）、2048 个固定文件、单文件 128 MiB、合计 512 MiB。超过则拆分明确范围的任务。

## 5. 交付、查看、重放

```powershell
node dist/bin.js agent deliver-output --prepared out/my-prepared --out out/my-delivery
node dist/bin.js batch-read --batch out/my-delivery/0001
node dist/bin.js record-read --record out/my-delivery/0001/0001
node dist/bin.js replay --record out/my-delivery/0001/0001 --out out/my-replay
```

交付前再次核对计划范围、原审核应用依据、固定候选与定义、全部文件哈希和引擎构建。即使把被改动的数据文件哈希一起改写，也不能换入未审核数据。准备完成后，后续工作空间或资源仓库变更不会混入该次交付；需要使用新内容时重新准备。引擎构建变化也需重新准备。

准备目录仍需能访问原审核轮次，不是跨机器的独立交付包；完成后的正式出图记录才支持独立重放。

交付根目录的 `delivery.json` 汇总各组；`0001/` 等组目录复用现有批次格式。逐项 PNG/JPEG、问题清单、布局摘要与自足出图记录位于 `0001/0001/` 等目录，正式成功项可用既有 `replay` 独立重放。顶层跳过数据集与列表跳过位置分别保留，未计入请求图片数。

| 状态 | 含义 |
|---|---|
| `prepared` | 已固定输入，尚未交付 |
| `delivered` | 全部计划渲染项正式交付成功 |
| `previewed` | 全部草稿预览已生成；预览不是正式成品，仍须查看严重问题数量 |
| `incomplete` | 有失败、未执行或批次级严重问题 |

Ctrl+C 在渲染项之间取消，当前项完成后停止，后续各组均保留 `notRun` 计数。返回 `incomplete` 时退出码为 1；每项问题可从对应批次目录查看。再次执行要使用新输出目录，系统不覆盖或自动补跑旧交付。强退留下没有 `delivery.json` 的目录属于未完成，子批次可用 `batch-read` 检查已完成项。

源码提取仍通过 Claude Code + OpenCode Go 原型入口运行；本阶段接续确定性的出图和记录，不改变模型执行器或生产隔离结论。
