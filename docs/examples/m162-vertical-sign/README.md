# M162 竖版线路牌示例

用两份数据定义（站点与线路牌）、一份数据集和两个模板，从用户提供的 350 × 950 mm 竖版站牌图出到正式 PNG：21 个站点按行驶方向纵向排列，本站黄色高亮，医院与地铁设施用图标标出。单张与三张批量均为 0 问题，输出 1654 × 4488 像素（350 × 950 mm，120 DPI）。

参考图由用户在 2026-10-22 提供（`download.png`，1654 × 4488 像素），本目录记录转录后的数据、模板与复现命令。示例图本身不进版本库。

## 文件

| 文件 | 内容 |
|---|---|
| [schema-stop-v1.json](schema-stop-v1.json) | 静态数据定义「竖版停靠站点 v1」：站名、所在道路、设施类别 |
| [compiled-stop-v1.schema.json](compiled-stop-v1.schema.json) | 上述定义的编译产物（JSON Schema 2020-12） |
| [schema-route-sign-v1.json](schema-route-sign-v1.json) | 静态数据定义「竖版线路牌 v1」：线路号、服务时间、票价与站点列表 |
| [compiled-route-sign-v1.schema.json](compiled-route-sign-v1.schema.json) | 上述定义的编译产物，站点引用展开为「竖版停靠站点 v1」 |
| [dataset-m162.json](dataset-m162.json) | M162 数据集：腾昌花园（四联路）开往大康福田村，21 站 |
| [template-stop-row.json](template-stop-row.json) | 循环模板「竖版站点行」：序号、站名与道路、本站高亮、设施图标 |
| [template-route-sign.json](template-route-sign.json) | 主模板「竖版线路牌主模板」：标题区、蓝色站点区、箭头纹、底部热线 |
| [render-request-m162.json](render-request-m162.json) | 单张正式请求：本站序号 1，350 × 950 mm，120 DPI，PNG |
| [render-batch-m162.json](render-batch-m162.json) | 三张批量请求：本站 1、不标本站、本站 10 |

数据定义已发布并编译为 v1，目录中直接放着发布产物，出图不需要再执行 `publish`。

## 数据定义与数据集

「竖版停靠站点 v1」三个字段：

- `name`：站名，必填，1–30 个字符；
- `road`：所在道路，必填，1–12 个字符，模板中以全角括号附在站名后；
- `facilities`：设施，可选列表，最多 1 项，取值限 `医院`、`地铁站`、`火车站`、`机场`。

「竖版线路牌 v1」五个字段：`routeNo`（1–8 字符）、`serviceStart` / `serviceEnd`（`time`）、`fare`（0–100）、`stops`（引用站点列表，2–40 项）。

本站序号不放进数据集：同一份数据集可出「本站 1」「本站 10」「不标本站」等不同图。主模板的公开参数 `currentIndex` 用 1 起的站序指定本站，`0` 表示不标；越界时报严重问题 `currentIndexWithinStops`。终点站由 `stops` 末项派生，不单独存字段。

数据集按参考图逐站转录，共 21 站。`328工业区（招呼站）`、`上中村（招呼站）`、`莘塘路口北（招呼站）`、`山子下路龙村路口（招呼站）` 把「招呼站」保留在站名内；`松柏保康路口` 标医院，`园山地铁站` 标地铁站。M162 的火车站与机场两个图标在当前数据中没有出现，资源仍保留以便同类线路复用。

## 模板结构

主模板画板固定 350 × 950 mm，自由布局，自上而下：

| 区域 | 做法 |
|---|---|
| 标题区 | 线路号 82 mm、字距收紧；「开往 + 终点站」29 mm；服务时间与票价 15.6 mm 灰色斜体 |
| 分隔 | y = 188 mm 起 9 mm 黄色条，y = 197 mm 起 663 mm 蓝色区 `#0154A4` |
| 行驶方向标 | 左侧 `#0A9EDC` 圆角底板配竖排说明，字号 11.7 mm，自动收紧字距并压缩字形 |
| 站点列表 | 纵向循环，x = 44 mm 起，宽 250 mm；行高与站名字号按站数派生 |
| 箭头纹 | 右侧一条 `path` 内重复 20 个向下箭头，`#006DB8`，不依赖循环 |
| 底部热线 | y = 860 mm 起 90 mm 黄条，热线文字分段换字重 |

站点行模板宽 50–300 mm、高 10–40 mm，横向堆叠：站名底板 + 设施图标（10.5 × 11 mm）。

- **本站高亮**：`isCurrent` 比较循环序号与 `currentIndex`。底板在 `true` 时填 `#FFF000`，站名文字转 `#0154A4` 并换粗体。
- **底板贴合文字**：按 `nameLength + roadLength + 2` 估算整行字符数，乘站名字号再加 12 mm 边距，得到底板宽，上限 228 mm；超长站名在底板内用 `compressGlyphs` 压缩字形（最低 60%），避免压到右侧箭头纹。
- **设施图标**：设施列表首项经 `facilityText` 分派到 `res:facility-hospital`、`facility-metro`、`facility-railway`、`facility-airport`；列表为空时图标整体 `visible: false`。
- **按站数自适应**：默认行高 31.3 mm、站名字号 14.3 mm。站数超过 21 时，行高改为 `657.3 / stopCount`；行高低于 26 mm 时，站名字号改为行高的 0.58 倍。21 站正好走默认值。

设施图标是手写 SVG，放在 `fixtures/resources/images/m162/`，资源 ID `facility-hospital`、`facility-metro`、`facility-railway`、`facility-airport` 登记在 `fixtures/resources/resources.json`。图形为示意标志，不是官方标识。

## 复现

单张正式出图（`fixtures/resources` 可直接用于 `render`）：

```bash
npm run render -- render --workspace docs/examples/m162-vertical-sign --resources fixtures/resources --request docs/examples/m162-vertical-sign/render-request-m162.json --out out/m162-vertical-sign/current-1
```

批量正式交付（`deliver` 只接受资源版本仓库，先初始化并导入；`--out` 必须是新目录）：

```bash
npm run render -- resources-init --resources out/m162-vertical-sign/resource-repo
npm run render -- resources-import --source fixtures/resources --resources out/m162-vertical-sign/resource-repo
npm run render -- deliver --workspace docs/examples/m162-vertical-sign --resources out/m162-vertical-sign/resource-repo --request docs/examples/m162-vertical-sign/render-batch-m162.json --out out/m162-vertical-sign/batch
```

需要重新发布数据定义时，先在空工作区发布站点定义，再以该工作区发布线路牌定义（线路牌引用站点 v1）：

```bash
npm run render -- publish --definition docs/examples/m162-vertical-sign/schema-stop-v1.json --workspace <空目录> --out <输出目录>
npm run render -- publish --definition docs/examples/m162-vertical-sign/schema-route-sign-v1.json --workspace <上一步输出目录> --out <输出目录>
```

## 验证记录

2026-10-22 实测：

- 单张：`out/m162-vertical-sign/current-1/image.png`，1654 × 4488 像素，`problems.json` 为 `[]`；
- 批量：复跑输出 `out/m162-vertical-sign/batch-verify/0001`（本站 1）、`0002`（不标本站）、`0003`（本站 10），三张都是 1654 × 4488 像素，问题清单均为 `[]`；此前交付的 `out/m162-vertical-sign/batch/` 同样 0 问题；
- 目视核对：站点顺序、站名与道路、两处设施图标、本站黄色高亮、底部热线与参考图一致。

与参考图的已知差异：

- 线路号参考图使用圆体、笔画更细；本图用思源黑体 Heavy，明显更粗，M162 与下方「开往」的间距也略小。
- 右侧箭头纹参考图约 14 个、单个更大；本图 20 个、密度更高。
- 首行高亮底板与第二行的视觉间距和参考图有几毫米差；全部 21 行仍落在同一蓝色区内。
- 参考图「328工业区」的数字之间有额外字距，本图按正常字距排。
