# 葵涌邮局（坪葵路西侧 02）竖版多线路站牌示例

用三份数据定义、一份数据集和四个模板，从用户提供的 1050 × 1660 mm 竖版站牌图出到正式 PNG：一块站牌上排 M438、M456、M569 三条线路，共 87 个站次；每条线路按自己的 `currentIndex` 高亮本站「葵涌邮局」，站名竖排、底对齐，已过站灰色、本站黄底红字、未到站黑色。

参考图由用户在 2026-10-22 提供（`坪葵路_葵涌邮局_西_02_1050x1660_反.png`，4961 × 7843 像素，120 DPI），本目录记录转录后的数据、模板与复现命令。示例图本身不进版本库。

## 文件

| 文件 | 内容 |
|---|---|
| [schema-stop-v1.json](schema-stop-v1.json) | 静态数据定义「竖版站牌站点 v1」：站名、所在道路 |
| [compiled-stop-v1.schema.json](compiled-stop-v1.schema.json) | 上述定义的编译产物（JSON Schema 2020-12） |
| [schema-route-v1.json](schema-route-v1.json) | 静态数据定义「竖版站牌线路 v1」：线路号、服务时间、票价、票价说明、下一站、运营单位、本站序号、站点列表 |
| [compiled-route-v1.schema.json](compiled-route-v1.schema.json) | 上述定义的编译产物，站点引用展开为「竖版站牌站点 v1」 |
| [schema-board-v1.json](schema-board-v1.json) | 静态数据定义「竖版多线路站牌 v1」：站名、英文名、热线、提示、二维码、标语、制作/监制单位、线路列表 |
| [compiled-board-v1.schema.json](compiled-board-v1.schema.json) | 上述定义的编译产物，线路引用展开为「竖版站牌线路 v1」 |
| [dataset-kuichong-west.json](dataset-kuichong-west.json) | 数据集：三条线路、87 个站次 |
| [template-stop-column.json](template-stop-column.json) | 循环模板「竖排站点列」：竖排站名、本站高亮、已过站灰色 |
| [template-road-band.json](template-road-band.json) | 循环模板「竖排道路带」：合并后的道路名与段分隔线 |
| [template-route-block.json](template-route-block.json) | 循环模板「竖版线路块」：单条线路卡，含本站校验与按站数派生字号 |
| [template-board.json](template-board.json) | 主模板「竖版多线路站牌主模板」：标题、信息区、线路循环、标语、页脚 |
| [render-request.json](render-request.json) | 正式请求：1050 × 1660 mm，120 DPI，PNG |

数据定义已发布并编译为 v1，目录中直接放着发布产物，出图不需要再执行 `publish`。

## 数据定义与数据集

三份定义按引用方向拆开：

- 「竖版站牌站点 v1」两个字段：`name`（站名，1–30 字符）、`road`（所在道路，1–12 字符）。
- 「竖版站牌线路 v1」八个字段：`routeNo`（1–8 字符）、`serviceStart` / `serviceEnd`（`time`）、`fare`（0–100 元）、`fareNote`（1–8 字符）、`nextStop`（1–30 字符）、`operator`（1–20 字符）、`currentIndex`（整数，1–60）、`stops`（引用站点列表，2–60 项）。终点站由 `stops` 末项派生，不单独存字段。
- 「竖版多线路站牌 v1」十个字段：`stationName`、`stationNameEn`、`hotline`、`notice`、`qrUrl`、`slogan`、`sloganEn`、`producer`、`supervisor`、`routes`（引用线路列表，1–6 项）。

本站序号放进每条线路，而不是整板一个参数：同一站名在三条线路上的位置不同，M438 是第 7 站、M456 是第 11 站、M569 是第 9 站。线路块模板用 `currentIndex` 取 `stops` 中对应项，并检查取到的 `name` 等于整板 `stationName`；不一致时报严重问题 `currentStationMatchesName`，避免序号与站名错位时静默出图。越界另报 `currentIndexWithinStops`。

数据集按参考图逐站转录：

- M438：20 站，丰树山公交首末站 → 核坝红树路口；
- M456：24 站，丰树山公交首末站 → 溪涌地铁站①；
- M569：43 站，葵涌公交总站 → 官湖总站 → 原路返回葵涌公交总站，官湖环线的往返段按参考图逐站保留。

三条线路合计 87 个站次。`当前站` 均按站名「葵涌邮局」写入对应 `currentIndex`。

## 模板结构

主模板画板固定 1050 × 1660 mm，深蓝底 `#0154A6`，白色圆角外框内缩约 105–139 mm，自上而下：

| 区域 | 做法 |
|---|---|
| 标题区 | x = 155、宽 740；站名 92 mm、字距 18 mm，英文名 32 mm |
| 信息区 | y = 290、高 153；顶部热线，中部图例与四类设施图标，左下两行横排「温馨」「提示」（粉字黄描边，各 30 mm），中部黄色提示条，右侧二维码 |
| 线路列 | y = 458 起，宽 740，三块线路卡纵向排列，每块高 165、间隔 4 |
| 标语区 | y = 964、高 506；中文标语 78 mm，英文 24 mm |
| 页脚 | y = 1528；制作单位左对齐、监制单位右对齐 |

线路块模板画板 740 × 165，分四段：34 mm 蓝色标题带（线路号、方向箭头、终点站、票价、运营单位）、99 mm 白色站点区、10 mm 道路带、20 mm 底部信息。站名字号按站数派生：30 站以内 11.8 mm，超过 30 站 10.8 mm；道路字号对应 5.4 / 4.7 mm。单站列宽由 `730 / stopCount` 派生，本站高亮底板取列宽减 1 mm，因此三条线路的高亮都正好覆盖一列。

站点列模板把站名竖排、底对齐，`stopState` 分 `passed` / `current` / `upcoming` 三态：已过站 `#C9CACA` 常规体，本站 `#E62129` 粗体配 `#FFF000` 底板，未到站 `#231815`。

道路带用 `mergeBy: "road"` 合并相邻同道路段，`spanBy: "groupSize"` 让合并段与站点列等宽；道路名 `horizontalAlign: "distribute"` 铺满合并段，左右各留 1 mm，段左边界画 0.3 mm `#666666` 分隔线，避免相邻道路名首尾相撞。

四类设施图标复用 `fixtures/resources/images/m162/` 的 `facility-hospital`、`facility-airport`、`facility-railway`、`facility-metro`，图形为示意标志，不是官方标识。

## 复现

单张正式出图：

```bash
npm run render -- render --workspace docs/examples/kuichong-post-office-board --resources fixtures/resources --request docs/examples/kuichong-post-office-board/render-request.json --out out/kuichong-post-office-board/final
```

需要重新发布数据定义时，按引用方向在空工作区依次发布 stop → route → board：

```bash
npm run render -- publish --definition docs/examples/kuichong-post-office-board/schema-stop-v1.json --workspace <空目录> --out <输出目录>
npm run render -- publish --definition docs/examples/kuichong-post-office-board/schema-route-v1.json --workspace <上一步输出目录> --out <输出目录>
npm run render -- publish --definition docs/examples/kuichong-post-office-board/schema-board-v1.json --workspace <再上一步输出目录> --out <输出目录>
```

## 验证记录

2026-10-22 实测：

- 正式出图 `out/kuichong-post-office-board/final/image.png`，4961 × 7843 像素，120 DPI，`problems.json` 为 `[]`；
- 三条线路的本站高亮分别落在 M438 第 7 站、M456 第 11 站、M569 第 9 站，均为「葵涌邮局」；
- 完整性检查反向验证：把 M438 的 `currentIndex` 临时改为 8，渲染报 `[严重] check.failed 竖版线路块 / currentStationMatchesName`，不出图，确认序号与站名不一致会被拦下；
- 目视核对：标题、热线、图例、三块线路卡、站名顺序、道路带、标语与页脚位置与参考图一致；信息区两行「温馨」「提示」、图例、热线与二维码互不重叠；道路带分隔线清晰，相邻道路名不再相撞。

与参考图的已知差异：

- 二维码内容无法从参考图可靠还原，数据里暂用 `https://jtys.sz.gov.cn/`，不是原码；二维码中心也没有参考图的公交标识。
- 参考图线路号是圆体、笔画更细；本图用思源黑体 Heavy，明显更粗。
- 参考图站名与道路名使用更窄的字体，字形比本图细；本图在 M569 等 43 站线路上略密。
- 参考图「公交车」等设施图标与二维码内标识为官方样式，本图用示意图标。
- 参考图「温馨提示」四个字各自旋转 90°、拼成 2 × 2 的方块；本图改为两行横排正立字，整体更矮更规整。
- 参考图「实时查」的三字排版和橙色勾形标记本图未逐像素复刻。
