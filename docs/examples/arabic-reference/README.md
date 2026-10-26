# 原图参考标注与字号诊断

2026-10-22。已从原图独立标注 86 个区域，旧候选全部匹配；16 个阿文站名墨迹高度只有参考的 **38.8%–57.7%**。这支持“本次站名字号明显偏小”，不把墨迹框高换算成 fontSize，也不把 11 mm 定为正确字号。

## 基准来源

- 原图：`out/arabic-board-retest-2026-10-20/r3-template/agent/sample.png`，3200×3600 像素，对应原请求的 800×900 mm 画板。
- SHA256：`622e340e787706113d6f579d53b892e4a7ed6f2a3b85041b5c2f0c5c6300f1da`。
- 可入库的坐标与匹配清单：[reference.json](reference.json)。原图、旧候选和完整生成物属于不入库材料，换机器先按[开发环境指南](../../dev-setup.md)恢复。
- 标注者是独立 coding agent。先查看原图、圈定 ROI，再从原始像素测量前景边界与主色；没有读取候选尺寸作为真值。人工查看了四张 contact sheet，文字 ROI 均不触边。此处不是客户批准记录；JSON 的 `approvedRegions` 是工具既有字段名。

清单包含 79 个文字区域、重复列出的本图最宽阿文站名及 6 个图形几何锚点。覆盖大标题、线路号、统计标签、表头、16 个阿文站名及 16 个副标题、换乘/分钟代表项、图例、服务信息和页脚。图形锚点是首站、过站、本站、普通、终点标记及本站高亮底块。

`complete:false`：未覆盖全图。图形只核对布局几何；精确文字颜色差异仅作诊断，未校准感知阈值。图标语义、底色、遮挡、层级、对比度和混排仍需审核。`longestText` 指本图实测最宽的阿文站名，不代表新数据压力测试。

## 实测

| 检查 | 原候选 | 仅阿文站名字号翻倍 |
|---|---|---|
| 16 个站名墨迹高度 / 原图 | 0.388–0.577，全数低于 0.8 | 0.776–1.153，15/16 落入诊断容差 0.8–1.2 |
| 实际字号 | 普通 5.5 mm，本站 6.2 mm | 普通 11 mm，本站 12.4 mm |
| 尺寸异常条数 | 170 | 137 |
| 位置异常条数 | 86 | 86 |
| 文字颜色精确差异条数 | 75 | 75 |
| 严重引擎问题 | `text.unshapedScript` | `text.unshapedScript` |

异常条数可能在同一区域分别计宽度、高度，不是错误区域数或还原分数。翻倍是因果干预，位置和塑形仍有问题，不能据此宣称模板通过。重复状态字号也同比修改，避免只改默认字号而遗漏本站覆盖。

原候选在 DPI 50 与 100 下，16 个站名的毫米尺寸、比例和源模板定位完全相同。全部 86 区域匹配，普通/本站/已过/终点/最长文本五种状态均有数值；`statesCovered` 仍为空、`unknownRegions` 仍是 86。旧候选的文件哈希验证前后不变。

真实样例还复现了工具输出问题：旧 `check_outcome` 54,311 字符被拒收。总预算修复后为 26,764 字符，保留 `unqualified`、能力受阻和所有问题分类计数；合同 0.10.1 的 `compare_reference` 为 25,620 字符、3 张局部图。分页遍历可取回全部 86 个区域 ID，页面图片属于本页目录。

## 复现

```powershell
node --import tsx scripts/annotate-arabic-reference.mjs
node --import tsx scripts/accept-arabic-reference.mjs
```

标注生成物：`out/agent-reference-annotation/reference.json`、`annotation-evidence.json`、`annotation.html`、`contact-1.png` 至 `contact-4.png`。诊断生成物：`out/arabic-reference-comparison/summary.json` 以及 `original/`、`arabic-double/`、`dpi-100/` 各自的完整报告、内容图和局部三联图。

两条命令均可指定输入/输出目录，脚本头部写明参数。标注脚本只接受上述图像哈希。离线比较使用实际公开 API；MCP 对照经公开 CLI 入口验证。不能将这次离线重放当作一次新模型复跑。
