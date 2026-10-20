# RenderWeave 模板参考（DSL 1.0，renderweave-template/1）

模板是出图函数：以一份静态数据定义为基准（base），把数据与参数排成一张图。单位一律是毫米；颜色写 `#RRGGBB` 或 `#RRGGBBAA`；字体与图片写资源引用 `res:资源ID`。工作区目录中的每个 `.json` 文件按内容归类（数据定义、模板、数据集、编译产物），文件名随意。

## 文件结构

```text
{
  "dslVersion": "renderweave-template/1",
  "name": "模板名（唯一，被调用时按名引用）",
  "base": { "name": "基准数据定义名", "version": 1 },
  "parameters": [ 参数, ... ],
  "derived": [ 派生变量, ... ],
  "checks": [ 检查项, ... ],
  "artboard": {
    "sizeRange": { "width": { "min": 毫米, "max": 毫米 }, "height": { "min": 毫米, "max": 毫米 } },
    "minFontSize": 毫米,
    "layout": { "mode": "free" },
    "padding": 毫米, "fill": "#FFFFFF", "stroke": { "color": "#000000", "width": 0.5 }, "cornerRadius": 毫米, "clip": false,
    "children": [ 元素, ... ]
  }
}
```

- 画板的实际尺寸由渲染请求（主模板）或调用框（被调模板）决定，必须落在 `sizeRange` 内。被调模板随内容定尺寸时，画板写 `"size": "hug"`。
- 画板的 `minFontSize` 是本模板文字缩字的最低字号，可选，缺省 5 mm，不低于 1.5 mm。价签一类近看的小标签按领域约定写低一些，否则小于 5 mm 的文字缩不了字。它只管缩字，不限制原始字号；被调模板要用就在自己的画板上写。
- 一个模板内，数据字段、参数、派生变量共用一个命名空间，不能重名。变量名用英文，中文写在 `displayName`。
- 不允许出现未定义的键；任何可选键都不能写成 null：要么写值，要么省略。
- 元素名称非空，不含 / [ ]，在同一模板内不能重复。
- 内置基准：`空数据定义 v1`（没有数据），以及单值数据定义 `单值·文本`、`单值·数值`、`单值·日期`、`单值·时刻`、`单值·时间`、`单值·布尔`、`单值·图片`（v1，唯一字段名 `value`），用于遍历基本类型列表。

## 变量与运算数

- 引用变量写 `{"var": "路径"}`，路径用"."经过单引用字段，例如 `{"var": "mainSession.room"}`；字面值写 `{"value": 文字、数值或布尔}`。
- **参数** `{"name", "displayName", "visibility": "public" 或 "internal", "type", "constraints"?, "default"?}`：type 为基本字段类型（text、number、date、time、datetime、boolean、image）或 `color`；internal 参数必须有 default。public 参数由渲染请求的 `parameters` 或调用方的 `args` 提供。
- **派生变量** `{"name", "displayName", "type", "ref"?, "op", ...}`，单步运算按名组合：
  - `branch`：`"branches": [{"when": 条件, "then": 运算数}], "otherwise": 运算数`
  - `pickItem`：`"list": {"var": 列表}, "position": "first" | "last" | {"index": 运算数}`（序号从 1 开始，越界得空值）；取出引用项时 type 写 `"ref"` 并写明 `"ref": {"name", "version"}`
  - `splitPart`（`type` 写 `"text"`）：`"of": {"var": 文本/数值/日期/时刻/时间变量}, "format"?: 展示格式, "delimiter": 非空文本或 {"var": 文本变量}, "position": "first" | "last" | {"index": 运算数}`（按分隔符拆取文本，如拆分价格整数与角分、主副站名；缺值、越界或分隔符未出现时的非首段均得空文本 `""`）
  - `length`：`"of": {"var": 列表或文本}`
  - `add` / `subtract` / `multiply` / `divide` / `mod`：`"left": 运算数, "right": 运算数`（十进制精确计算，除法四舍五入保留最多 15 位有效数字）
- **条件** 写成单个比较 `{"left": 运算数, "op": 比较, "right": 运算数}`，或单层复合条件 `{"all": [比较…]}`（全部成立）、`{"any": [比较…]}`（任一成立）；比较取 eq、ne、lt、le、gt、ge、empty、notEmpty（后两个不写 right）。
- **检查项** `{"name", "displayName"?, "problemWhen": {"var": 布尔变量}, "level": "severe" 或 "hint", "message"}`。
- 一个派生变量只能写自己这种运算的键。

## 绑定与状态样式

- 可绑定的属性直接把值写成运算数即为绑定，例如 `"source": {"var": "logo"}`、`"color": {"var": "accentColor"}`、`"visible": {"var": "hasPhoto"}`；尺寸写成 `{"fixed": {"var": "size"}}`。
- 状态样式：`"states": {"by": {"var": 变量}, "cases": {"取值": {属性: 值}}}`。按变量取值覆盖元素属性；未列出的取值沿用元素自身属性；布尔取值写 `"true"`/`"false"`。不能覆盖 type、name、children、states、template。
- 隐藏元素（`visible` 为 false）不占位。

## 布局与位置

容器与画板用 `layout` 排子元素，子元素用 `place` 定位，可写的键随父容器的布局而定：

| 布局 | layout | 子元素 place |
|---|---|---|
| 自由（缺省） | `{"mode": "free"}` | left 或 right、top 或 bottom（缺省距左 0、距上 0）、width、height |
| 堆叠 | `{"mode": "stack", "direction": "row" 或 "column", "gap", "justifyContent": start/center/end/spaceBetween/spaceEvenly, "alignItems": start/center/end}` | width、height、margin、alignSelf |
| 网格 | `{"mode": "grid", "rows": [轨道…], "columns": [轨道…], "rowGap", "columnGap"}`，轨道为 `{"fixed": 毫米}`、`{"fraction": 比例}` 或 `"hug"` | row、column（从 1 开始）、rowSpan、columnSpan、width、height、margin、justifySelf、alignSelf |

- 宽高写 `{"fixed": 毫米}`、`"hug"`（随内容）、`"fill"` 或 `{"fill": 权重}`；三种布局都可另写 minWidth、maxWidth、minHeight、maxHeight。未写宽高时，网格中填满，堆叠与自由中随内容。
- 网格轨道：fixed 取定值；hug 取放在这条轨道上的元素中最大的，跨多条轨道的元素会撑开所跨的 hug 轨道；fraction 按份数分剩余空间。元素连同 margin 比所在单元格大时报 `layout.contentOverflow`，要调整轨道或元素尺寸。
- padding、margin 写一个毫米数或 `{top, right, bottom, left}` 中的若干项；cornerRadius 写一个毫米数或 `{topLeft, topRight, bottomRight, bottomLeft}` 中的若干项。

## 元素

所有元素都有 `type`、`name`（同一容器内唯一，不能含"/"），可写 `place`、`visible`、`opacity`（0–1）、`rotation`（度）、`states`。

- **container**：layout、padding、fill、stroke、cornerRadius、clip、children。
- **text**：
  - `content` 是片段列表：文字 `{"text": "票价："}`，插槽 `{"slot": "变量路径", "format"?: 展示格式}`；片段可单独写 font、fontSize、color、slant。
  - 元素属性：`font`（如 `res:font-hei-bold`；字重靠换字体，不写 fontWeight）、`fontSize`（毫米）、`color`、`writingMode`（horizontal 缺省或 vertical）、`horizontalAlign`（start、center、end、distribute 两端分布、spaceEvenly 同间隔分布）、`verticalAlign`（top、center、bottom；竖排可用 distribute）、`slant`（倾斜度数，-45–45，只用于横排）、`stroke`（`{"color", "width"}` 文字描边）、`padding`、`fit`。
  - 竖排文字的片段只能单独写 color。
  - 展示格式：日期与时刻用 yyyy、MM、M、dd、d、HH、H、mm、ss，例如 `HH:mm`；数值用 0 与 #，例如 `0.##`。
  - `fit`（放不下时的适配，不写则不适配）：
    - 横排：`{"steps": ["compressGlyphs", "shrink"], "compressMin": 0.6, "minFontSize": 5, "onFail": "severe" 或 "hint"}`，先横向压缩字形再缩字，顺序不可颠倒；minFontSize 缺省取画板的 minFontSize（画板没写时为 5 mm），只能调高；只写 compressGlyphs 则只压缩、不缩字。
    - 竖排：`{"steps": ["tightenSpacing", "compressGlyphs"], "compressMin": 0.6}`，先收紧字距再压缩字形。
    - 跨实例统一字号（例如同一张图上一组标签必须同字号）：`"widthOverflow": {"shrinkGroup": "组名", "minFontSize": 5}`；同名组在一次出图内共用，宽度不足时全组统一缩到同一字号，最低是各成员下限中最高的，缺省取所在画板的 minFontSize。
- **image**：`{"source": "res:资源ID" 或 {"var": 图片字段}, "fit": "contain"（缺省）| "cover" | "fill"}`；没有 source 时不画内容。
- **rect**（fill、stroke、cornerRadius）、**ellipse**（fill、stroke）、**line**（from、to、stroke 必填，坐标写成 `[x, y]`，毫米、相对元素框左上角）、**polygon**（points 至少 3 个 `[x, y]` 顶点）、**path**（SVG 路径 d、fill、stroke、fillRule）。图形 stroke 为 `{"color", "width", "dash"?: [实, 空], "cap"?: butt/round/square}`。路径与多边形坐标以毫米计、相对元素框，框变大时不拉伸。
- **qrcode**：二维码。属性如下：
  - `content`：文本或文本变量，必填；
  - `errorCorrectionLevel`：取 L、M（缺省）、Q、H；
  - `foreground`、`background`：前景色与背景色，缺省为黑码白底，必须不透明且不同色。

  码区保持方形，并自带必要留白；尺寸或 DPI 不足时会报问题。
- **barcode**：条形码。属性如下：
  - `content`：文本或文本变量，必填，按文本处理，保留前导零；
  - `format`：CODE128、EAN-13、EAN-8 或 UPC-A，必填；EAN/UPC 要写含校验位的完整编号；
  - `foreground`、`background`：前景色与背景色；
  - `showText`：是否在码下方显示文字，为 true 时必须写 `font`；
  - `fontSize`：下方文字的字号，缺省 3。

### 循环与调用

- **loop**：遍历列表，每项调用一次另一个模板。
  ```json
  { "type": "loop", "name": "场次列", "list": {"var": "sessions"}, "template": "场次行",
    "args": { "index": {"loop": "index"}, "count": {"loop": "count"}, "accent": {"var": "accentColor"} },
    "itemLayout": { "direction": "row", "widths": "equal", "gap": 1 } }
  ```
  - 被调模板的 base 必须是列表元素的数据定义；基本类型列表（如 list<time>）用对应的单值数据定义（如 `单值·时刻 v1`，字段 `value`）。
  - 方向：`"direction": "row"`（缺省）从左往右排，用 `widths` 定每项宽度，高度填满循环区域；`"direction": "column"` 从上往下排，用 `heights` 定每项高度，宽度填满循环区域。竖排的列表（如站台竖牌的站点）用 column，不要把横向循环旋转 90°。
  - `widths` / `heights` 取值相同：`equal`（等分）、`content`（随内容，被调模板的画板写 `"size": "hug"`）或 `{"fixed": 毫米}`。横向写 heights、纵向写 widths 都是错误。
  - 列表项的总长（含 gap）超出循环区域会报问题；按数据的最大项数核对循环区域够不够。
  - 循环信息只能经 args 传给被调模板：`{"loop": "index" | "isFirst" | "isLast" | "count" | "groupSize"}`，被调模板要声明同名的 public 参数接收。
  - 合并相邻同值项：`"mergeBy": "字段路径"`，同时 `"itemLayout": {"direction": "row", "widths": "equal", "spanBy": "groupSize"}`。相邻且取值相同的项合并成一组，组宽为组内项数的列宽之和；被调模板取组内首项数据，`{"loop": "groupSize"}` 给出组内项数。合并只支持横向循环。
- **call**：调用一个子模板一次，`{"type": "call", "template": "模板名", "data": {"var": "单引用字段"} | "current" | "none", "args": {...}}`。被调模板按调用框的实际尺寸重新排布，作用域不继承：需要的值都要经 data 或 args 传入。

## 渲染请求（草稿预览工具的参数）

```text
{ "template": "主模板名", "dataset": {"id": "数据集 ID"}, "parameters": {"public 参数名": 值},
  "output": { "width": 毫米, "height": 毫米, "dpi": 50, "format": "png" } }
```

预览工具固定用草稿模式，不必写 `mode`；正式的渲染请求另须写 `"mode": "draft"` 或 `"final"`。

`dataset` 也可以写成 `{"inline": 数据集文档}`，数据集文档的格式与数据集文件相同，内联时 `dataset.id` 可省略。用它可以试验其他数据，例如项数最少、最多或文本最长的情况。

预览返回问题清单（含元素路径，如 `简易胸牌/标签列[2]/标签文字`）和预览图。严重问题会在草稿上画红框，并用占位代替缺失内容。

## 示例：会议胸牌

数据定义与数据集见 dsl-reference.md（数据定义参考）中的"胸牌 v1"。

标签格（基本类型列表 tags 的循环项，按内容宽度排列，所以画板写 size: hug）：

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

日程行（参会场次 sessions 的循环项，纵向循环里每项固定高度、宽度填满）：

```json
{
  "dslVersion": "renderweave-template/1",
  "name": "日程行",
  "base": {
    "name": "场次",
    "version": 1
  },
  "artboard": {
    "sizeRange": {
      "width": {
        "min": 20,
        "max": 100
      },
      "height": {
        "min": 3,
        "max": 10
      }
    },
    "layout": {
      "mode": "stack",
      "direction": "row",
      "gap": 1.5,
      "alignItems": "center"
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
        "fontSize": 3,
        "color": "#1F2328"
      },
      {
        "type": "text",
        "name": "场次名称",
        "place": {
          "width": "fill"
        },
        "content": [
          {
            "slot": "title"
          }
        ],
        "font": "res:font-hei-regular",
        "fontSize": 3,
        "color": "#57606A",
        "fit": {
          "steps": [
            "compressGlyphs"
          ]
        }
      }
    ]
  }
}
```

简易胸牌（主模板）：

```json
{
  "dslVersion": "renderweave-template/1",
  "name": "简易胸牌",
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
        }
      ],
      "otherwise": {
        "var": "accentColor"
      }
    }
  ],
  "artboard": {
    "sizeRange": {
      "width": {
        "min": 80,
        "max": 100
      },
      "height": {
        "min": 130,
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
    "padding": 3,
    "layout": {
      "mode": "grid",
      "rows": [
        {
          "fixed": 10
        },
        {
          "fixed": 40
        },
        {
          "fixed": 12
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
        "type": "text",
        "name": "页眉",
        "place": {
          "row": 1,
          "column": 1,
          "columnSpan": 2
        },
        "content": [
          {
            "text": "参会证 · "
          },
          {
            "slot": "eventDate",
            "format": "M月d日"
          }
        ],
        "font": "res:font-hei-bold",
        "fontSize": 4.5,
        "color": {
          "var": "roleColor"
        },
        "verticalAlign": "center"
      },
      {
        "type": "text",
        "name": "身份",
        "place": {
          "row": 2,
          "column": 1,
          "rowSpan": 2
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
          ]
        }
      },
      {
        "type": "image",
        "name": "照片",
        "place": {
          "row": 2,
          "column": 2
        },
        "source": {
          "var": "photo"
        },
        "fit": "contain"
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
        "type": "loop",
        "name": "标签列",
        "place": {
          "row": 4,
          "column": 2
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
        "type": "loop",
        "name": "日程列",
        "place": {
          "row": 5,
          "column": 2
        },
        "list": {
          "var": "sessions"
        },
        "template": "日程行",
        "itemLayout": {
          "direction": "column",
          "heights": {
            "fixed": 4.5
          },
          "gap": 0.5
        }
      },
      {
        "type": "qrcode",
        "name": "签到码",
        "place": {
          "row": 6,
          "column": 2,
          "width": {
            "fixed": 20
          },
          "height": {
            "fixed": 20
          },
          "justifySelf": "end"
        },
        "content": {
          "var": "badgeNo"
        },
        "errorCorrectionLevel": "M"
      }
    ]
  }
}
```
