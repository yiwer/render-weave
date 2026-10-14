# RenderWeave 模板 DSL 参考（renderweave-template/1）

模板是出图函数：以一份静态数据定义为基准（base），把数据与参数排成一张图。单位一律是毫米；颜色写 `#RRGGBB` 或 `#RRGGBBAA`；字体与图片写资源引用 `res:资源ID`。工作区目录中的每个 `.json` 文件按内容归类（数据定义、模板、数据集、编译产物），文件名随意。

## 文件结构

```json
{
  "dslVersion": "renderweave-template/1",
  "name": "模板名（唯一，被调用时按名引用）",
  "base": { "name": "基准数据定义名", "version": 1 },
  "parameters": [ 参数, ... ],
  "derived": [ 派生变量, ... ],
  "checks": [ 检查项, ... ],
  "artboard": {
    "sizeRange": { "width": { "min": 毫米, "max": 毫米 }, "height": { "min": 毫米, "max": 毫米 } },
    "layout": { "mode": "free" },
    "padding": 毫米, "fill": "#FFFFFF", "stroke": { "color": "#000000", "width": 0.5 }, "cornerRadius": 毫米, "clip": false,
    "children": [ 元素, ... ]
  }
}
```

- 画板的实际尺寸由渲染请求（主模板）或调用框（被调模板）决定，必须落在 `sizeRange` 内。被调模板随内容定尺寸时，画板写 `"size": "hug"`。
- 一个模板内，数据字段、参数、派生变量共用一个命名空间，不能重名。变量名用英文，中文写在 `displayName`。
- 内置基准：`空数据定义 v1`（没有数据），以及单值数据定义 `单值·文本`、`单值·数值`、`单值·日期`、`单值·时刻`、`单值·时间`、`单值·布尔`、`单值·图片`（v1，唯一字段名 `value`），用于遍历基本类型列表。

## 变量与运算数

- 引用变量写 `{"var": "路径"}`，路径用"."经过单引用字段，例如 `{"var": "terminal.name"}`；字面值写 `{"value": 文字、数值或布尔}`。
- **参数** `{"name", "displayName", "visibility": "public" 或 "internal", "type", "constraints"?, "default"?}`：type 为基本字段类型（text、number、date、time、datetime、boolean、image）或 `color`；internal 参数必须有 default。public 参数由渲染请求的 `parameters` 或调用方的 `args` 提供。
- **派生变量** `{"name", "displayName", "type", "ref"?, "op", ...}`，单步运算按名组合：
  - `branch`：`"branches": [{"when": 条件, "then": 运算数}], "otherwise": 运算数`
  - `pickItem`：`"list": {"var": 列表}, "position": "first" | "last" | {"index": 运算数}`（序号从 1 开始，越界得空值）；取出引用项时 type 写 `"ref"` 并写明 `"ref": {"name", "version"}`
  - `length`：`"of": {"var": 列表或文本}`
  - `add` / `subtract`：`"left": 运算数, "right": 运算数`
- **条件** `{"left": 运算数, "op": 比较, "right": 运算数}`，比较取 eq、ne、lt、le、gt、ge、empty、notEmpty（后两个不写 right）。
- **检查项** `{"name", "problemWhen": {"var": 布尔变量}, "level": "severe" 或 "hint", "message"}`。

## 绑定与状态样式

- 可绑定的属性直接把值写成运算数即为绑定，例如 `"source": {"var": "logo"}`、`"color": {"var": "accentColor"}`、`"visible": {"var": "hasLandmark"}`；尺寸写成 `{"fixed": {"var": "size"}}`。
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
    - 横排：`{"steps": ["compressGlyphs", "shrink"], "compressMin": 0.6, "minFontSize": 5, "onFail": "severe" 或 "hint"}`，先横向压缩字形再缩字，顺序不可颠倒；minFontSize 缺省 5 mm，只能调高，不能低于 5 mm；只写 compressGlyphs 则只压缩、不缩字。
    - 竖排：`{"steps": ["tightenSpacing", "compressGlyphs"], "compressMin": 0.6}`，先收紧字距再压缩字形。
    - 跨实例统一字号（例如同一张图上一组标签必须同字号）：`"widthOverflow": {"shrinkGroup": "组名", "minFontSize": 5}`；同名组在一次出图内共用，宽度不足时全组统一缩到同一字号，最低 5 mm。
- **image**：`{"source": "res:资源ID" 或 {"var": 图片字段}, "fit": "contain"（缺省）| "cover" | "fill"}`；没有 source 时不画内容。
- **rect**（fill、stroke、cornerRadius）、**ellipse**（fill、stroke）、**line**（from、to、stroke 必填，坐标写成 `[x, y]`，毫米、相对元素框左上角）、**polygon**（points 至少 3 个 `[x, y]` 顶点）、**path**（SVG 路径 d、fill、stroke、fillRule）。图形 stroke 为 `{"color", "width", "dash"?: [实, 空], "cap"?: butt/round/square}`。路径与多边形坐标以毫米计、相对元素框，框变大时不拉伸。
- **qrcode** / **barcode**：二维码、条形码，本任务一般用不到。

### 循环与调用

- **loop**：遍历列表，每项调用一次另一个模板。
  ```json
  { "type": "loop", "name": "规格列", "list": {"var": "specs"}, "template": "规格格子",
    "args": { "index": {"loop": "index"}, "count": {"loop": "count"}, "accent": {"var": "accentColor"} },
    "itemLayout": { "direction": "row", "widths": "equal", "gap": 1 } }
  ```
  - 被调模板的 base 必须是列表元素的数据定义；基本类型列表（如 list<time>）用对应的单值数据定义（如 `单值·时刻 v1`，字段 `value`）。
  - `itemLayout.widths`：`equal`（等分）、`content`（随内容）或 `{"fixed": 毫米}`；目前只能横向（row），每项高度填满循环区域。
  - 循环信息只能经 args 传给被调模板：`{"loop": "index" | "isFirst" | "isLast" | "count" | "groupSize"}`，被调模板要声明同名的 public 参数接收。
  - 合并相邻同值项：`"mergeBy": "字段路径"`，同时 `"itemLayout": {"direction": "row", "widths": "equal", "spanBy": "groupSize"}`。相邻且取值相同的项合并成一组，组宽为组内项数的列宽之和；被调模板取组内首项数据，`{"loop": "groupSize"}` 给出组内项数。
- **call**：调用一个子模板一次，`{"type": "call", "template": "模板名", "data": {"var": "单引用字段"} | "current" | "none", "args": {...}}`。被调模板按调用框的实际尺寸重新排布，作用域不继承：需要的值都要经 data 或 args 传入。

## 渲染请求（草稿预览工具的参数）

```json
{ "template": "主模板名", "dataset": {"id": "数据集 ID"}, "parameters": {"public 参数名": 值},
  "output": { "width": 毫米, "height": 毫米, "dpi": 50, "format": "png" } }
```

`dataset` 也可以写成 `{"inline": 数据集文档}`，数据集文档的格式与数据集文件相同，内联时 `dataset.id` 可省略。用它可以试验其他数据，例如项数最少、最多或文本最长的情况。

预览返回问题清单（含元素路径，如 `主模板/面板/规格列[3]/名称`）和预览图。严重问题会在草稿上画红框，并用占位代替缺失内容。

## 示例：商品价签

数据定义"价签 v1"有 productName、price（数值）、unit、logo（图片）与 specs（list<ref 规格项 v1>，规格项含 label、value）。

规格格子模板：
```json
{
  "dslVersion": "renderweave-template/1",
  "name": "规格格子",
  "base": { "name": "规格项", "version": 1 },
  "parameters": [
    { "name": "index", "displayName": "序号", "visibility": "public", "type": "number" },
    { "name": "accent", "displayName": "强调色", "visibility": "public", "type": "color" }
  ],
  "derived": [
    { "name": "isFirst", "displayName": "是否首项", "type": "boolean", "op": "branch",
      "branches": [ { "when": { "left": { "var": "index" }, "op": "eq", "right": { "value": 1 } }, "then": { "value": true } } ],
      "otherwise": { "value": false } }
  ],
  "artboard": {
    "sizeRange": { "width": { "min": 5, "max": 200 }, "height": { "min": 5, "max": 100 } },
    "layout": { "mode": "stack", "direction": "column", "gap": 1, "alignItems": "center" },
    "padding": 1,
    "children": [
      { "type": "text", "name": "规格名", "content": [ { "slot": "label" } ], "font": "res:font-hei-regular", "fontSize": 3, "color": "#666666",
        "states": { "by": { "var": "isFirst" }, "cases": { "true": { "color": { "var": "accent" } } } } },
      { "type": "text", "name": "规格值", "content": [ { "slot": "value" } ], "font": "res:font-hei-bold", "fontSize": 4, "color": "#222222",
        "fit": { "steps": ["compressGlyphs"], "compressMin": 0.6 } }
    ]
  }
}
```

主模板：
```json
{
  "dslVersion": "renderweave-template/1",
  "name": "标准价签",
  "base": { "name": "价签", "version": 1 },
  "parameters": [
    { "name": "accentColor", "displayName": "强调色", "visibility": "internal", "type": "color", "default": "#D2401E" }
  ],
  "derived": [
    { "name": "specCount", "displayName": "规格数", "type": "number", "op": "length", "of": { "var": "specs" } },
    { "name": "hasSpecs", "displayName": "有规格", "type": "boolean", "op": "branch",
      "branches": [ { "when": { "left": { "var": "specCount" }, "op": "gt", "right": { "value": 0 } }, "then": { "value": true } } ],
      "otherwise": { "value": false } }
  ],
  "artboard": {
    "sizeRange": { "width": { "min": 60, "max": 120 }, "height": { "min": 30, "max": 60 } },
    "fill": "#FFFFFF", "stroke": { "color": "#D2401E", "width": 0.6 }, "cornerRadius": 2,
    "layout": { "mode": "grid", "rows": [ { "fixed": 12 }, { "fraction": 1 }, { "fixed": 14 } ], "columns": [ { "fraction": 1 }, { "fixed": 28 } ] },
    "padding": 3,
    "children": [
      { "type": "text", "name": "品名", "place": { "row": 1, "column": 1 }, "content": [ { "slot": "productName" } ],
        "font": "res:font-hei-bold", "fontSize": 6, "color": "#222222", "verticalAlign": "center",
        "fit": { "steps": ["compressGlyphs", "shrink"], "minFontSize": 5 } },
      { "type": "image", "name": "品牌标志", "place": { "row": 1, "column": 2 }, "source": { "var": "logo" }, "fit": "contain" },
      { "type": "loop", "name": "规格列", "place": { "row": 2, "column": 1, "columnSpan": 2 }, "visible": { "var": "hasSpecs" },
        "list": { "var": "specs" }, "template": "规格格子",
        "args": { "index": { "loop": "index" }, "accent": { "var": "accentColor" } },
        "itemLayout": { "direction": "row", "widths": "equal", "gap": 1 } },
      { "type": "text", "name": "售价", "place": { "row": 3, "column": 1, "columnSpan": 2 }, "horizontalAlign": "end", "verticalAlign": "bottom",
        "content": [ { "text": "¥", "fontSize": 6 }, { "slot": "price", "format": "0.00" }, { "text": "/" }, { "slot": "unit" } ],
        "font": "res:font-hei-heavy", "fontSize": 10, "color": { "var": "accentColor" } }
    ]
  }
}
```
