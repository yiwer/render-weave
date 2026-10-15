# 渲染请求与批次请求（DSL 1.0）

- 渲染请求描述一次出图：用哪个模板、哪份数据集、对外参数取什么值、出多大的图、草稿还是正式。
- 批次请求把同一个模板的多次出图列在一起，逐项交付（M63、M153）。

结构契约：[render-request.schema.json](../../schemas/render-request.schema.json)、[batch-request.schema.json](../../schemas/batch-request.schema.json)。交付行为、出图记录与重放见[出图记录](../output-records.md)。

## 渲染请求

| 键 | 必填 | 写法 |
|---|---|---|
| `template` | 是 | 主模板名 |
| `dataset` | 是 | 二选一：`{ "id": 数据集 ID }` 引用工作区中的数据集；或 `{ "inline": 数据集文档 }` 附带一份数据集文档，此时 `dataset.id` 可省略（S16）。只能写其中一个键 |
| `parameters` | 否 | 对外参数名到取值的对象，取值写法同数据集；内部参数不能赋值 |
| `output` | 是 | `{ "width", "height", "dpi", "format" }`：宽高为毫米，`dpi` 大于 0，`format` 取 `png` 或 `jpg`（`jpeg` 同义） |
| `mode` | 是 | `draft` 草稿预览，或 `final` 正式出图（M102） |

不允许其他键，`parameters` 不能写成 `null`（M224）。

- 出图像素按 `毫米 × dpi / 25.4` 计算，单边须在 1–20,000 像素之间，总像素不超过 1 亿。
- 命令行：`renderweave render --workspace <工作区> --resources <资源仓库> --request <请求.json> --out <输出目录>`。

## 批次请求

```text
{ "template": 主模板名, "mode": "draft" | "final", "items": [ { "id", "dataset", "parameters"?, "output" }, … ] }
```

- **渲染项数量**：`items` 有 1–1,000 项（M153），超过就拆成多个批次。
- **渲染项的写法**：每项的 `dataset`、`parameters`、`output` 写法与渲染请求相同；模板与模式由整批统一，渲染项不能各自写 `mode`。
- **渲染项标识 `id`**：批次内唯一，只作为数据保存，不直接用作文件名。
- **整批拒绝**：外层结构错误、标识重复、项数超限时，整批拒绝，不产生任何成果。
- **单项失败**：某一项的数据、参数、尺寸或码内容有问题，只有这一项失败，其他项照常交付。
- **批次清单不是请求**：交付后生成的批次清单 `batch.json` 带格式标识 `renderweave-batch/1`，它是交付成果，见[出图记录](../output-records.md)。
- **命令行**：`renderweave deliver --workspace <工作区> --resources <版本仓库> --request <批次请求.json> --out <新批次目录>`。

## 示例

按[会议胸牌模板](template.md#示例会议胸牌)出一张草稿，数据集引用工作区中的 `badge-0001`：

```json
{
  "template": "标准胸牌",
  "dataset": { "id": "badge-0001" },
  "parameters": { "showQr": true },
  "output": { "width": 90, "height": 130, "dpi": 120, "format": "png" },
  "mode": "draft"
}
```

两张胸牌的正式批次。第二项附带一份内联数据集，并关闭签到码：

```json
{
  "template": "标准胸牌",
  "mode": "final",
  "items": [
    { "id": "zhangsan", "dataset": { "id": "badge-0001" }, "output": { "width": 90, "height": 130, "dpi": 300, "format": "png" } },
    {
      "id": "lisi",
      "dataset": {
        "inline": {
          "dataset": { "staticSchema": { "name": "胸牌", "version": 1 } },
          "data": { "fullName": "李四", "role": "工作人员", "badgeNo": "ST0002", "eventDate": "2026-11-20" }
        }
      },
      "parameters": { "showQr": false },
      "output": { "width": 90, "height": 130, "dpi": 300, "format": "jpg" }
    }
  ]
}
```

## Schema 之外的检查

只看一份请求就能判断（公开入口 `checkDslDocument`）：

| 类别 | 问题代码 | 例子 |
|---|---|---|
| 出图像素超限 | `request.outputTooLarge` | 1500 mm 宽、400 DPI，单边 23,622 像素 |
| 渲染项标识重复 | `request.invalid` | 两个渲染项都叫 `zhangsan`（整批拒绝） |

需要工作区才能判断（由渲染与交付入口报告）：

| 类别 | 问题代码 |
|---|---|
| 模板、数据集不存在 | `input.templateNotFound`、`input.datasetNotFound` |
| 数据集与模板基准不是同一个静态数据定义版本 | `dataset.staticSchemaMismatch` |
| 参数缺失、未知、给内部参数赋值、取值不合规 | `parameter.missing`、`parameter.unknown`、`parameter.internal`、`parameter.invalid` |
| 数据不符合静态数据定义 | 见[数据定义与数据集](data-definition.md#schema-之外的检查) |
| 出图尺寸不在模板的 `sizeRange` 内 | `render.sizeOutOfRange` |

## 已知限制

- 一个批次只有一个主模板、一种模式；不能按数据自动展开渲染项（例如"每站一张"），需要逐项列出。
- 批次按顺序逐项执行，项与项之间可以取消，不能中断正在绘制的一项（M191）。
- 渲染选项（后备字体、SVG 字体）不写在请求里，由命令行的 `--options` 或公开入口的参数给出。
