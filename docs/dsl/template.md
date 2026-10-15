# 模板（DSL 1.0）

模板是出图函数：以一份静态数据定义为基准（`base`），把数据与参数排成一张图（ADR-0007）。所有模板地位平等。沿数据定义的引用，模板可以调用子模板，或在循环里逐项调用另一个模板；被调模板的作用域不继承调用方。

- **结构契约**：[template.schema.json](../../schemas/template.schema.json)；
- **兼容策略**：[ADR-0016](../adr/0016-dsl-1-compatibility.md)；
- **真实样例**：[M402 线路牌模板](../examples/m402-dsl/README.md)；
- **元素模型与设计取舍**：[模板元素目录](../model/template-elements.md)。

单位一律是毫米。颜色写 `#RRGGBB` 或 `#RRGGBBAA`。字体与图片写资源引用 `res:资源ID`，资源 ID 以字母或数字开头，只含字母、数字、`_`、`-`（S8）。

## 文件结构

| 键 | 必填 | 写法 |
|---|---|---|
| `dslVersion` | 是 | 固定为 `"renderweave-template/1"` |
| `name` | 是 | 模板名，在工作区内唯一，被调用时按名引用（S13） |
| `base` | 是 | 基准静态数据定义 `{ "name", "version" }`，只能有这两个键 |
| `parameters` | 否 | 参数列表 |
| `derived` | 否 | 派生变量列表 |
| `checks` | 否 | 检查项列表 |
| `artboard` | 是 | 画板 |

不允许其他键；任何可选键都不能写成 `null`（M223、M224）。

- **内置基准**（S9、S27）：引擎提供 `空数据定义 v1`（没有数据），以及七种单值数据定义 `单值·文本`、`单值·数值`、`单值·日期`、`单值·时刻`、`单值·时间`、`单值·布尔`、`单值·图片`。它们都是 v1，唯一字段名为 `value`，用于遍历基本类型的列表。工作区不能覆盖这些内置名称。
- **命名**（S1、S3）：一个模板内，数据字段、参数、派生变量共用一个命名空间，不能重名。变量名用英文，中文写在 `displayName`。

## 变量

模板里能引用的变量有三类：基准数据定义的字段、参数、派生变量（M2、M15、ADR-0004）。

### 运算数与路径

| 写法 | 含义 |
|---|---|
| `{ "var": "路径" }` | 引用变量。路径用"."经过单引用字段，如 `{ "var": "mainSession.room" }`（S2） |
| `{ "value": 固定值 }` | 文字、数值或布尔字面值 |
| `{ "loop": "index" }` | 循环信息，只能写在循环容器的 `args` 里，取值见「循环」 |

### 参数

```text
{ "name", "displayName", "visibility": "public" | "internal", "type", "constraints"?, "default"? }
```

- **`type`**：可取 `text`、`number`、`date`、`time`、`datetime`、`boolean`、`image`、`color`。
- **`visibility`**：
  - `public` 是对外参数，由渲染请求的 `parameters` 或调用方的 `args` 提供；
  - `internal` 是内部参数，必须写 `default`（M15）。
- **约束**：数值参数可写 `integer`、`min`、`max`、`enum`；文本参数可写 `minLength`、`maxLength`、`pattern`、`enum`；其他类型不能写约束。
- **`default`**：取值写法同数据集。日期如 `"2026-01-02"`，时刻如 `"07:30"`，图片写 `res:资源ID`，颜色写 `#RRGGBB`。

### 派生变量

派生变量是单步运算，按名组合（ADR-0004）。每项写成 `{ "name", "displayName", "type", "ref"?, "op", 运算的键… }`，必须声明结果类型 `type`（S11）。结果是引用时，`type` 写 `ref`，并用 `ref` 写明静态数据定义。

| `op` | 运算的键 | 含义 |
|---|---|---|
| `branch` | `branches`：`[{ "when": 条件, "then": 运算数 }]`；`otherwise`：运算数（必填） | 条件分支，取第一个成立的分支 |
| `pickItem` | `list`：`{ "var": 列表 }`；`position`：`"first"`、`"last"` 或 `{ "index": 运算数 }` | 取列表中的一项，序号从 1 开始；越界时结果为空，不报错（S12） |
| `length` | `of`：`{ "var": 列表或文本 }` | 列表项数，或文本的字符数 |
| `add`、`subtract` | `left`、`right`：运算数 | 加、减 |

**条件**写成 `{ "left": 运算数, "op": 比较, "right": 运算数 }`。比较取 `eq`、`ne`、`lt`、`le`、`gt`、`ge`、`empty`、`notEmpty`；后两个只有左侧，不写 `right`。

一个派生变量只能写自己这种运算的键，例如 `branch` 不能同时写 `of`。

### 检查项

```text
{ "name", "displayName"?, "problemWhen": 运算数, "level": "severe" | "hint", "message" }
```

`problemWhen` 为真时报告问题（`check.failed`）。正式出图时，`severe` 级的检查项会阻止交付（M102）。

## 绑定与状态样式

可绑定的属性直接把值写成 `{ "var": … }`，这就是绑定，不另设绑定列表（S4、M71）。例如 `"fill": { "var": "roleColor" }`、`"visible": { "var": "hasSessions" }`。尺寸写成 `{ "fixed": { "var": "size" } }`。

| 能绑定 | 属性 |
|---|---|
| 颜色 | `fill`、描边的 `color`、文字 `color` 与片段 `color`、码的 `foreground` 与 `background` |
| 数值 | `fontSize` 与片段 `fontSize`、`slant`、`opacity`、`rotation`、描边 `width`、`padding`、`margin`、`cornerRadius`、`place` 中的位置与行列、`{ "fixed": … }`、尺寸上下限、布局的 `gap`、`rowGap`、`columnGap`，循环的 `itemLayout.gap` 与 `widths.fixed`，条形码 `fontSize` |
| 布尔 | `visible`、`clip`、条形码 `showText` |
| 图片 | 图片元素的 `source` |
| 文本 | 码元素的 `content`；文字内容经插槽绑定 |

**不能绑定**：`font`（需要按取值换字体时用状态样式）、路径的 `d`、多边形的 `points`、线条端点、各种枚举（对齐方式、书写方向、适配步骤）、网格轨道、虚线 `dash`、元素类型、被调模板名、展示格式、`sizeRange`。

**状态样式**（M28、S5）按变量的取值覆盖元素属性：

```text
"states": { "by": { "var": 变量 }, "cases": { "取值": { 属性: 值 } } }
```

- 未列出的取值沿用元素自身的属性。
- 布尔取值写作 `"true"` 或 `"false"`。
- 覆盖值可以是字面值，也可以是变量。
- 不能覆盖 `type`、`name`、`children`、`states`、`template`。
- 引擎会把每个取值的覆盖与元素合并后重新检查。

**隐藏**：`visible` 为 false 的元素不参与布局、不占位（M27）。隐藏元素的其余属性在出图时不求值。

## 画板

| 键 | 必填 | 写法 |
|---|---|---|
| `sizeRange` | 是 | 适用尺寸范围 `{ "width": { "min", "max" }, "height": { "min", "max" } }`，毫米，大于 0，`min` 不大于 `max` |
| `size` | 否 | 只能写 `"hug"`：被调模板按内容的自然尺寸，例如按内容宽度排列的循环项（M92） |
| `layout`、`padding`、`fill`、`stroke`、`cornerRadius`、`clip`、`children` | 否 | 同容器 |

画板的实际尺寸由渲染请求（主模板）或调用框（被调模板）决定，并且必须落在 `sizeRange` 之内。被调模板按调用框的实际尺寸重新排布，不整体缩放（S26）。

## 布局与位置

容器与画板用 `layout` 排列子元素，子元素用 `place` 定位。`place` 可写的键随父容器的布局而定（S14、S19、M111）：

| 布局 | `layout` | 子元素的 `place` |
|---|---|---|
| 自由（缺省） | `{ "mode": "free" }` | `left` 或 `right`、`top` 或 `bottom`（缺省为距左 0、距上 0），以及 `width`、`height` |
| 堆叠 | `{ "mode": "stack", "direction": "row" \| "column", "gap"?, "justifyContent"?, "alignItems"? }` | `width`、`height`、`margin`、`alignSelf` |
| 网格 | `{ "mode": "grid", "rows": [轨道…], "columns": [轨道…], "rowGap"?, "columnGap"? }` | `row`、`column`（必填，从 1 开始，S10）、`rowSpan`、`columnSpan`、`width`、`height`、`margin`、`justifySelf`、`alignSelf` |

- **三种布局通用**：都可以另写 `minWidth`、`maxWidth`、`minHeight`、`maxHeight`。
- **堆叠的分布与对齐**：`justifyContent` 取 `start`、`center`、`end`、`spaceBetween`、`spaceEvenly`，缺省为 `start`；`alignItems` 取 `start`、`center`、`end`，缺省为 `start`。
- **网格轨道**：每项写 `{ "fixed": 毫米 }`、`{ "fraction": 比例 }` 或 `"hug"`。
- **宽高**：可写 `{ "fixed": 毫米 }`、`"hug"`（随内容）、`"fill"` 或 `{ "fill": 权重 }`。没写宽高时，网格中填满，堆叠与自由布局中随内容。
- **自由布局的位置**：横向只能写 `left` 或 `right` 之一，纵向只能写 `top` 或 `bottom` 之一（M93）。
- **边距与圆角**：`padding`、`margin` 写一个毫米数，或写 `{ top, right, bottom, left }` 中的若干项；`cornerRadius` 写一个毫米数，或写 `{ topLeft, topRight, bottomRight, bottomLeft }` 中的若干项（S20）。

## 元素

所有元素都有 `type` 与 `name`。名称非空，不含 `/`、`[`、`]`，在同一模板内唯一，用来组成元素路径（M101），如 `标准胸牌/底栏/签到码`。所有元素都可以写 `place`、`visible`（布尔）、`opacity`（0–1）、`rotation`（度）与 `states`（S20）。

| `type` | 用途 | 专有属性 |
|---|---|---|
| `container` | 容器 | `layout`、`padding`、`fill`、`stroke`、`cornerRadius`、`clip`、`children` |
| `text` | 文字 | 见「文字」 |
| `image` | 图片（S22） | `source`：`res:资源ID` 或图片变量；`fit`：`contain`（缺省，完整显示）、`cover`、`fill`。没有 `source` 时不画内容 |
| `qrcode` | 二维码 | `content`（文本或文本变量，必填）、`errorCorrectionLevel`：`L`、`M`（缺省）、`Q`、`H`；`foreground`、`background`，见[二维码说明](../render-qrcode.md) |
| `barcode` | 条形码 | `content`（必填）、`format`：`CODE128`、`EAN-13`、`EAN-8`、`UPC-A`（必填）、`foreground`、`background`、`showText`、`font`（显示文字时必填）、`fontSize`（缺省 3），见[条形码说明](../render-barcode.md)与 [EAN/UPC 说明](../render-retail-barcodes.md) |
| `rect` | 矩形 | `fill`、`stroke`、`cornerRadius` |
| `ellipse` | 椭圆 | `fill`、`stroke` |
| `line` | 线条 | `from`、`to`：`[x, y]`，相对元素框左上角；`stroke` 必填 |
| `polygon` | 多边形 | `points`：至少 3 个 `[x, y]`；`fill`、`stroke` |
| `path` | 路径 | `d`：SVG 路径数据，单位毫米；`fill`、`stroke`、`fillRule`：`nonzero`（缺省）或 `evenodd` |
| `loop` | 循环容器 | 见「循环」 |
| `call` | 子模板调用 | 见「调用」 |

- **图形的描边**：写成 `{ "color", "width", "dash"?: [实, 空, …], "cap"?: "butt" | "round" | "square" }`。
- **坐标**：路径与多边形的坐标以毫米计，相对元素框，框变大时图形不拉伸（M94）。

### 文字

| 键 | 写法 |
|---|---|
| `content` | 片段列表（必填）。文字片段 `{ "text": 文字 }`；变量插槽 `{ "slot": 变量路径, "format"?: 展示格式 }`。两种片段都可另写 `font`、`fontSize`、`color`、`slant`（S23） |
| `font` | 资源引用（必填）。字重靠换字体资源，不写 `fontWeight`（M115） |
| `fontSize` | 毫米（必填） |
| `color` | 缺省为黑色 |
| `writingMode` | `horizontal`（缺省）或 `vertical`（S18） |
| `horizontalAlign` | `start`（缺省）、`center`、`end`；横排另可用 `distribute`（两端分布，S29）与 `spaceEvenly`（同间隔分布，两侧留白与字间距相同，S30、M131） |
| `verticalAlign` | `top`（缺省）、`center`、`bottom`；竖排另可用 `distribute` |
| `slant` | 倾斜角度，绝对值不超过 45；只用于横排（S23） |
| `stroke` | 文字描边 `{ "color", "width" }` |
| `padding` | 内边距 |
| `fit` | 放不下时的处理，见下文。不写则不做适配，放不下即报问题（M109） |

**展示格式**（M116）：
- 日期与时刻用 `yyyy`、`MM`、`M`、`dd`、`d`、`HH`、`H`、`mm`、`ss`，例如 `HH:mm`、`yyyy年M月d日`；
- 数值用 `0` 与 `#`，例如 `0`、`0.##`、`0.00`，按十进制四舍五入；
- 未写格式时，按类型的缺省写法输出。

**竖排文字**按统一的字号与字格排列，片段只能单独写 `color`（M109）。

`fit` 写成 `{ "steps", "compressMin"?, "minFontSize"?, "onFail"?, "widthOverflow"? }`：

| 书写方向 | `steps` 的写法 | 其他 |
|---|---|---|
| 横排 | `[]`、`["compressGlyphs"]` 或 `["compressGlyphs", "shrink"]`：先横向压缩字形，再同比缩小字号（M84、S29） | `minFontSize` 只用于 `shrink`，缺省为 5，不能低于 5（M86） |
| 竖排 | `[]`、`["tightenSpacing"]` 或 `["tightenSpacing", "compressGlyphs"]`：先收紧字距，字距收到 0 才压缩字形（M82） | `widthOverflow`：`{ "shrinkGroup": 组名, "minFontSize"?: 毫米 }`，见下文 |

- **`compressMin`**：压缩字形的下限，缺省 0.6，只能调高到 1 为止（M88）。
- **`onFail`**：仍放不下时报 `severe`（缺省）或 `hint`。
- **缩字组**（S31、M132–M134）：同名的组在一次出图内共用，跨循环与子模板。宽度不足时，全组统一缩到同一字号，最低 5 mm，组名首尾不能有空白。

### 循环

```text
{ "type": "loop", "name", "list": { "var": 列表 }, "template": 模板名, "args"?: { 参数名: 运算数 },
  "itemLayout": { "direction": "row", "widths": "equal" | "content" | { "fixed": 毫米 }, "gap"?, "spanBy"? },
  "mergeBy"?: 字段路径, "padding"?, "fill"?, "stroke"?, "cornerRadius"?, "clip"? }
```

- **被调模板的基准**：必须是列表元素的数据定义；基本类型列表用对应的单值数据定义，例如 `list<text>` 用 `单值·文本 v1`，字段为 `value`。
- **每项的宽度与高度**：`widths` 可取 `equal`（等分）、`content`（随内容，被调模板的画板写 `"size": "hug"`）或 `{ "fixed": 毫米 }`。方向目前只有横向（`row`），每项高度填满循环区域（S25）。
- **循环信息**：只能经 `args` 传给被调模板，写成 `{ "loop": "index" | "isFirst" | "isLast" | "count" | "groupSize" }`，被调模板要声明同名的 public 参数来接收。序号从 1 开始。
- **合并相邻同值项**（S28、M127–M130）：写 `"mergeBy": "字段路径"`，同时写 `"itemLayout": { "direction": "row", "widths": "equal", "spanBy": "groupSize" }`。
  - 相邻且取值严格相等的项合并成一组；缺值的项各自成组。
  - 组宽是组内各项的列宽加上内部间距；被调模板取组内首项的数据。
  - `{ "loop": "groupSize" }` 给出组内项数。

### 调用

```text
{ "type": "call", "name", "template": 模板名, "data"?: { "var": 单引用字段 } | "current" | "none", "args"?: { 参数名: 运算数 } }
```

- **`data`**（S26）：
  - 缺省为 `none`，即不传数据；
  - `current` 传调用方当前的数据；
  - `{ "var": … }` 传一个单引用字段。
- **作用域**：被调模板按调用框的实际尺寸重新排布，作用域不继承，需要的值都要经 `data` 或 `args` 传入。
- **调用信息不能变**：被调模板名不能经状态样式更换。

## 示例：会议胸牌

基于[数据定义与数据集](data-definition.md#示例会议胸牌)中的"胸牌 v1"与"场次 v1"。主模板"标准胸牌"用网格布局，13 种元素都用到了：

- 竖排身份与缩字组；
- 姓名的状态样式与横排适配；
- 场次循环、按会场合并的循环；
- 按内容宽度排列的标签循环；
- 主场次调用；
- 条形码与二维码。

示例数据在 90 × 130 mm、120 DPI 下出图为 0 问题，测试会实际渲染这四个模板。

场次行（循环项，也被单独调用）：

```json
{
  "dslVersion": "renderweave-template/1",
  "name": "场次行",
  "base": {
    "name": "场次",
    "version": 1
  },
  "parameters": [
    {
      "name": "isLast",
      "displayName": "是否末项",
      "visibility": "public",
      "type": "boolean",
      "default": false
    }
  ],
  "artboard": {
    "sizeRange": {
      "width": {
        "min": 5,
        "max": 100
      },
      "height": {
        "min": 5,
        "max": 40
      }
    },
    "layout": {
      "mode": "stack",
      "direction": "column",
      "gap": 0.5,
      "alignItems": "center",
      "justifyContent": "center"
    },
    "padding": {
      "top": 0.5,
      "bottom": 0.5
    },
    "children": [
      {
        "type": "text",
        "name": "开始时刻",
        "content": [
          {
            "slot": "startsAt",
            "format": "HH:mm"
          }
        ],
        "font": "res:font-hei-bold",
        "fontSize": 3.5,
        "color": "#1F2328"
      },
      {
        "type": "text",
        "name": "场次名称",
        "content": [
          {
            "slot": "title"
          }
        ],
        "font": "res:font-hei-regular",
        "fontSize": 2.8,
        "color": "#57606A",
        "horizontalAlign": "center",
        "place": {
          "width": "fill"
        },
        "fit": {
          "steps": [
            "compressGlyphs"
          ],
          "compressMin": 0.6
        }
      }
    ]
  }
}
```

标签格（基本类型列表的循环项，按内容宽度排列）：

```json
{
  "dslVersion": "renderweave-template/1",
  "name": "标签格",
  "base": {
    "name": "单值·文本",
    "version": 1
  },
  "parameters": [
    {
      "name": "accent",
      "displayName": "强调色",
      "visibility": "public",
      "type": "color",
      "default": "#1F6FEB"
    }
  ],
  "artboard": {
    "sizeRange": {
      "width": {
        "min": 2,
        "max": 60
      },
      "height": {
        "min": 2,
        "max": 20
      }
    },
    "size": "hug",
    "layout": {
      "mode": "stack",
      "direction": "row",
      "alignItems": "center"
    },
    "padding": {
      "left": 1.5,
      "right": 1.5,
      "top": 0.5,
      "bottom": 0.5
    },
    "fill": "#F6F8FA",
    "stroke": {
      "color": {
        "var": "accent"
      },
      "width": 0.3
    },
    "cornerRadius": 1.5,
    "children": [
      {
        "type": "text",
        "name": "标签文字",
        "content": [
          {
            "slot": "value"
          }
        ],
        "font": "res:font-hei-medium",
        "fontSize": 3,
        "color": {
          "var": "accent"
        }
      }
    ]
  }
}
```

会场格（按会场合并的循环项）：

```json
{
  "dslVersion": "renderweave-template/1",
  "name": "会场格",
  "base": {
    "name": "场次",
    "version": 1
  },
  "derived": [
    {
      "name": "hasRoom",
      "displayName": "有会场",
      "type": "boolean",
      "op": "branch",
      "branches": [
        {
          "when": {
            "left": {
              "var": "room"
            },
            "op": "notEmpty"
          },
          "then": {
            "value": true
          }
        }
      ],
      "otherwise": {
        "value": false
      }
    }
  ],
  "artboard": {
    "sizeRange": {
      "width": {
        "min": 1,
        "max": 100
      },
      "height": {
        "min": 1,
        "max": 20
      }
    },
    "layout": {
      "mode": "stack",
      "direction": "row",
      "justifyContent": "spaceEvenly",
      "alignItems": "center"
    },
    "fill": "#EAEEF2",
    "cornerRadius": 1,
    "children": [
      {
        "type": "text",
        "name": "会场名",
        "content": [
          {
            "slot": "room"
          }
        ],
        "font": "res:font-hei-medium",
        "fontSize": 2.8,
        "color": "#57606A",
        "visible": {
          "var": "hasRoom"
        }
      }
    ]
  }
}
```

标准胸牌（主模板）：

```json
{
  "dslVersion": "renderweave-template/1",
  "name": "标准胸牌",
  "base": {
    "name": "胸牌",
    "version": 1
  },
  "parameters": [
    {
      "name": "accentColor",
      "displayName": "主色",
      "visibility": "internal",
      "type": "color",
      "default": "#1F6FEB"
    },
    {
      "name": "eventName",
      "displayName": "会议名称",
      "visibility": "internal",
      "type": "text",
      "constraints": {
        "maxLength": 20
      },
      "default": "2026 出图技术大会"
    },
    {
      "name": "maxSessions",
      "displayName": "可选场次上限",
      "visibility": "internal",
      "type": "number",
      "constraints": {
        "integer": true,
        "min": 1
      },
      "default": 6
    },
    {
      "name": "showQr",
      "displayName": "显示签到码",
      "visibility": "public",
      "type": "boolean",
      "default": true
    }
  ],
  "derived": [
    {
      "name": "roleColor",
      "displayName": "身份色",
      "type": "color",
      "op": "branch",
      "branches": [
        {
          "when": {
            "left": {
              "var": "role"
            },
            "op": "eq",
            "right": {
              "value": "讲者"
            }
          },
          "then": {
            "value": "#D2401E"
          }
        },
        {
          "when": {
            "left": {
              "var": "role"
            },
            "op": "eq",
            "right": {
              "value": "嘉宾"
            }
          },
          "then": {
            "value": "#7A3EB1"
          }
        }
      ],
      "otherwise": {
        "var": "accentColor"
      }
    },
    {
      "name": "sessionCount",
      "displayName": "场次数",
      "type": "number",
      "op": "length",
      "of": {
        "var": "sessions"
      }
    },
    {
      "name": "hasSessions",
      "displayName": "有场次",
      "type": "boolean",
      "op": "branch",
      "branches": [
        {
          "when": {
            "left": {
              "var": "sessionCount"
            },
            "op": "gt",
            "right": {
              "value": 0
            }
          },
          "then": {
            "value": true
          }
        }
      ],
      "otherwise": {
        "value": false
      }
    },
    {
      "name": "firstSession",
      "displayName": "第一场",
      "type": "ref",
      "ref": {
        "name": "场次",
        "version": 1
      },
      "op": "pickItem",
      "list": {
        "var": "sessions"
      },
      "position": "first"
    },
    {
      "name": "remainingSessions",
      "displayName": "剩余可选场次",
      "type": "number",
      "op": "subtract",
      "left": {
        "var": "maxSessions"
      },
      "right": {
        "var": "sessionCount"
      }
    },
    {
      "name": "hasOrganization",
      "displayName": "有单位",
      "type": "boolean",
      "op": "branch",
      "branches": [
        {
          "when": {
            "left": {
              "var": "organization"
            },
            "op": "notEmpty"
          },
          "then": {
            "value": true
          }
        }
      ],
      "otherwise": {
        "value": false
      }
    },
    {
      "name": "noPhoto",
      "displayName": "缺照片",
      "type": "boolean",
      "op": "branch",
      "branches": [
        {
          "when": {
            "left": {
              "var": "photo"
            },
            "op": "empty"
          },
          "then": {
            "value": true
          }
        }
      ],
      "otherwise": {
        "value": false
      }
    }
  ],
  "checks": [
    {
      "name": "photoMissing",
      "displayName": "缺照片",
      "problemWhen": {
        "var": "noPhoto"
      },
      "level": "hint",
      "message": "没有照片，照片区留空"
    }
  ],
  "artboard": {
    "sizeRange": {
      "width": {
        "min": 80,
        "max": 100
      },
      "height": {
        "min": 120,
        "max": 140
      }
    },
    "fill": "#FFFFFF",
    "stroke": {
      "color": {
        "var": "roleColor"
      },
      "width": 0.6
    },
    "cornerRadius": 3,
    "clip": true,
    "padding": 3,
    "layout": {
      "mode": "grid",
      "rows": [
        {
          "fixed": 14
        },
        {
          "fixed": 36
        },
        {
          "fixed": 11
        },
        {
          "fixed": 6
        },
        {
          "fixed": 13
        },
        {
          "fixed": 5
        },
        {
          "fraction": 1
        },
        {
          "fixed": 22
        }
      ],
      "columns": [
        {
          "fixed": 10
        },
        {
          "fraction": 1
        }
      ],
      "rowGap": 1,
      "columnGap": 1
    },
    "children": [
      {
        "type": "container",
        "name": "页眉",
        "place": {
          "row": 1,
          "column": 1,
          "columnSpan": 2
        },
        "layout": {
          "mode": "free"
        },
        "fill": {
          "var": "roleColor"
        },
        "cornerRadius": 2,
        "children": [
          {
            "type": "text",
            "name": "会议名",
            "place": {
              "left": 3,
              "top": 2,
              "width": {
                "fixed": 60
              },
              "height": {
                "fixed": 8
              }
            },
            "content": [
              {
                "slot": "eventName"
              }
            ],
            "font": "res:font-hei-bold",
            "fontSize": 4.5,
            "color": "#FFFFFF",
            "slant": 8,
            "verticalAlign": "center",
            "stroke": {
              "color": "#00000033",
              "width": 0.1
            }
          },
          {
            "type": "ellipse",
            "name": "徽点",
            "place": {
              "right": 3,
              "top": 4,
              "width": {
                "fixed": 6
              },
              "height": {
                "fixed": 6
              }
            },
            "fill": "#FFFFFF",
            "stroke": {
              "color": "#FFFFFF80",
              "width": 0.3
            }
          },
          {
            "type": "path",
            "name": "波纹",
            "place": {
              "left": 0,
              "bottom": 1,
              "width": {
                "fixed": 84
              },
              "height": {
                "fixed": 3
              }
            },
            "d": "M0 2 C 20 0, 40 4, 60 2 S 80 0, 84 2",
            "stroke": {
              "color": "#FFFFFF66",
              "width": 0.4,
              "cap": "round"
            },
            "fillRule": "nonzero"
          }
        ]
      },
      {
        "type": "text",
        "name": "身份",
        "place": {
          "row": 2,
          "column": 1,
          "rowSpan": 3
        },
        "content": [
          {
            "slot": "role"
          }
        ],
        "font": "res:font-hei-bold",
        "fontSize": 6,
        "color": {
          "var": "roleColor"
        },
        "writingMode": "vertical",
        "verticalAlign": "distribute",
        "horizontalAlign": "center",
        "fit": {
          "steps": [
            "tightenSpacing",
            "compressGlyphs"
          ],
          "compressMin": 0.6,
          "widthOverflow": {
            "shrinkGroup": "身份字号",
            "minFontSize": 5
          }
        }
      },
      {
        "type": "container",
        "name": "照片区",
        "place": {
          "row": 2,
          "column": 2
        },
        "layout": {
          "mode": "free"
        },
        "clip": true,
        "children": [
          {
            "type": "image",
            "name": "照片",
            "place": {
              "left": 23,
              "top": 1,
              "width": {
                "fixed": 28
              },
              "height": {
                "fixed": 34
              }
            },
            "source": {
              "var": "photo"
            },
            "fit": "cover"
          },
          {
            "type": "rect",
            "name": "相框",
            "place": {
              "left": 23,
              "top": 1,
              "width": {
                "fixed": 28
              },
              "height": {
                "fixed": 34
              }
            },
            "stroke": {
              "color": "#D0D7DE",
              "width": 0.4
            },
            "cornerRadius": 1
          },
          {
            "type": "polygon",
            "name": "角标",
            "place": {
              "left": 23,
              "top": 1,
              "width": {
                "fixed": 8
              },
              "height": {
                "fixed": 8
              }
            },
            "points": [
              [
                0,
                0
              ],
              [
                8,
                0
              ],
              [
                0,
                8
              ]
            ],
            "fill": {
              "var": "roleColor"
            }
          }
        ]
      },
      {
        "type": "text",
        "name": "姓名",
        "place": {
          "row": 3,
          "column": 2
        },
        "content": [
          {
            "slot": "fullName"
          }
        ],
        "font": "res:font-hei-heavy",
        "fontSize": 8,
        "color": "#1F2328",
        "horizontalAlign": "center",
        "verticalAlign": "center",
        "fit": {
          "steps": [
            "compressGlyphs",
            "shrink"
          ],
          "minFontSize": 5
        },
        "states": {
          "by": {
            "var": "role"
          },
          "cases": {
            "讲者": {
              "color": "#D2401E"
            }
          }
        }
      },
      {
        "type": "text",
        "name": "单位",
        "place": {
          "row": 4,
          "column": 2
        },
        "content": [
          {
            "slot": "organization"
          }
        ],
        "font": "res:font-hei-regular",
        "fontSize": 3.5,
        "color": "#57606A",
        "horizontalAlign": "center",
        "visible": {
          "var": "hasOrganization"
        },
        "fit": {
          "steps": [
            "compressGlyphs"
          ]
        }
      },
      {
        "type": "loop",
        "name": "场次列",
        "place": {
          "row": 5,
          "column": 2
        },
        "visible": {
          "var": "hasSessions"
        },
        "list": {
          "var": "sessions"
        },
        "template": "场次行",
        "args": {
          "isLast": {
            "loop": "isLast"
          }
        },
        "itemLayout": {
          "direction": "row",
          "widths": "equal",
          "gap": 1
        }
      },
      {
        "type": "loop",
        "name": "会场带",
        "place": {
          "row": 6,
          "column": 2
        },
        "list": {
          "var": "sessions"
        },
        "template": "会场格",
        "mergeBy": "room",
        "itemLayout": {
          "direction": "row",
          "widths": "equal",
          "spanBy": "groupSize",
          "gap": 0.5
        }
      },
      {
        "type": "container",
        "name": "标签与主场次",
        "place": {
          "row": 7,
          "column": 2
        },
        "layout": {
          "mode": "stack",
          "direction": "row",
          "gap": 1,
          "alignItems": "center"
        },
        "children": [
          {
            "type": "loop",
            "name": "标签列",
            "place": {
              "height": {
                "fixed": 5
              }
            },
            "list": {
              "var": "tags"
            },
            "template": "标签格",
            "args": {
              "accent": {
                "var": "roleColor"
              }
            },
            "itemLayout": {
              "direction": "row",
              "widths": "content",
              "gap": 1
            }
          },
          {
            "type": "call",
            "name": "主场次",
            "place": {
              "width": {
                "fixed": 24
              },
              "height": {
                "fixed": 9
              }
            },
            "template": "场次行",
            "data": {
              "var": "mainSession"
            },
            "args": {
              "isLast": {
                "value": true
              }
            }
          }
        ]
      },
      {
        "type": "container",
        "name": "底栏",
        "place": {
          "row": 8,
          "column": 1,
          "columnSpan": 2
        },
        "layout": {
          "mode": "grid",
          "rows": [
            {
              "fixed": 1
            },
            {
              "fraction": 1
            }
          ],
          "columns": [
            {
              "fraction": 1
            },
            {
              "fixed": 20
            }
          ],
          "columnGap": 2
        },
        "children": [
          {
            "type": "container",
            "name": "分隔",
            "place": {
              "row": 1,
              "column": 1,
              "columnSpan": 2
            },
            "layout": {
              "mode": "free"
            },
            "children": [
              {
                "type": "line",
                "name": "分隔线",
                "place": {
                  "left": 0,
                  "top": 0,
                  "width": {
                    "fixed": 84
                  },
                  "height": {
                    "fixed": 1
                  }
                },
                "from": [
                  0,
                  0.5
                ],
                "to": [
                  84,
                  0.5
                ],
                "stroke": {
                  "color": "#D0D7DE",
                  "width": 0.3,
                  "dash": [
                    1,
                    0.6
                  ]
                }
              }
            ]
          },
          {
            "type": "barcode",
            "name": "证件条码",
            "place": {
              "row": 2,
              "column": 1
            },
            "content": {
              "var": "badgeNo"
            },
            "format": "CODE128",
            "showText": true,
            "font": "res:font-hei-regular",
            "fontSize": 2.5
          },
          {
            "type": "qrcode",
            "name": "签到码",
            "place": {
              "row": 2,
              "column": 2
            },
            "content": {
              "var": "badgeNo"
            },
            "errorCorrectionLevel": "M",
            "visible": {
              "var": "showQr"
            }
          }
        ]
      }
    ]
  }
}
```

对应的渲染请求见[渲染请求与批次请求](requests.md#示例)。

## Schema 之外的检查

以下问题 JSON Schema 表达不了，由引擎报告。一致性测试会核对：凡是 Schema 接受、而引擎拒绝的模板，问题都在下面列出的类别里。

只看一份模板就能判断（公开入口 `checkDslDocument`）：

| 类别 | 问题代码 | 例子 |
|---|---|---|
| 元素名称重复 | `template.duplicateElementName` | 两个元素同名 |
| 网格行列越界 | `template.invalid` | 网格只有 3 行，元素占到第 4 行 |
| 尺寸上下限颠倒 | `template.invalid` | `minWidth` 大于 `maxWidth`；`sizeRange` 的 `min` 大于 `max` |
| 参数约束或缺省值不合规 | `template.invalid` | `min` 大于 `max`；`pattern` 不是合法正则；缺省值违反约束，或不是真实存在的日期 |
| 展示格式不合法 | `template.invalid` | `format` 不是可识别的日期时刻或数值格式 |
| 状态样式覆盖后不合规 | `template.invalid` 等 | 覆盖值与元素合并后不符合该元素的规则，例如覆盖成竖排却带倾斜 |

需要其他文档才能判断（由模板静态检查与渲染入口报告）：

| 类别 | 问题代码 |
|---|---|
| 模板或被调模板不存在 | `input.templateNotFound` |
| 基准静态数据定义不存在或没有编译产物 | `input.staticSchemaNotFound`、`input.compiledSchemaMissing` |
| 变量未声明、路径不合法、重名 | `template.unknownVariable`、`template.invalidPath`、`template.duplicateVariable` |
| 类型对不上（绑定、插槽、运算数、展示格式与类型） | `template.typeMismatch` |
| 派生变量循环引用、模板调用成环 | `template.variableCycle`、`template.callCycle` |
| 被调模板的基准与传入的数据不符 | `template.callBaseMismatch`、`template.loopBaseMismatch` |
| 状态样式列出的取值不在变量的取值范围内 | `template.unknownStateValue` |
| 参数缺失、未知、内部参数被外部赋值、取值不合规 | `parameter.missing`、`parameter.unknown`、`parameter.internal`、`parameter.invalid` |
| 出图时绑定取到的值不可用、求值失败、检查项成立 | `template.bindingValueInvalid`、`template.evaluationInvalid`、`check.failed` |

## 已知限制

DSL 1.0 照实记录以下能力边界；改变它们需要新的决定，并按 ADR-0016 处理兼容。

- **循环只能横向排列**，每项高度填满循环区域；没有纵向循环、自动换行或两排。
- **没有段落换行**：一个文字元素是一行（竖排是一列），放不下时按 `fit` 适配。
- **没有文本表达式与脚本**：只有五种单步运算（ADR-0004）。拼接文字用多个片段。
- **没有动态模板**：被调模板名不能由数据决定，循环也没有过滤、反序或附加项。
- **竖排文字的片段只能单独设颜色**，竖排不能倾斜。
- **不能绑定**：字体、路径数据、多边形顶点、线条端点不能绑定变量。
- **URL 图片尚未支持**：不画内容并报问题（见[数据定义](data-definition.md#已知限制)）。

## 与起草约定的对应

M402 草稿中的约定 S1–S31（[M402 DSL 草稿](../examples/m402-dsl/README.md)）在 DSL 1.0 中的位置：

| 约定 | 本文位置 |
|---|---|
| S1 命名语言、S3 共用命名空间、S9 单值数据定义、S13 模板按名引用 | 文件结构 |
| S2 运算数与路径、S11 比较与结果类型、S12 取项越界为空、S24 模板变量 | 变量 |
| S4 绑定、S5 状态样式 | 绑定与状态样式 |
| S6 数据集文件、S7 拒绝未定义的键、S21 数据定义类型 | [数据定义与数据集](data-definition.md) |
| S8 资源引用 | 开头 |
| S10 网格从 1 编号、S14 自由布局、S19 三种布局、S20 外观与图形 | 布局与位置、元素 |
| S15 对齐、S18 竖排与适配、S23 文字内容、S29 两端分布与横排适配、S30 同间隔分布、S31 缩字组 | 文字 |
| S16 渲染请求、S17 资源清单 | [渲染请求与批次请求](requests.md)、[资源版本说明](../resources-versioning.md) |
| S22 图片 | 元素 |
| S25 循环容器、S28 合并相邻同值项 | 循环 |
| S26 子模板调用、S27 内置基准与路径 | 调用、文件结构、元素 |
