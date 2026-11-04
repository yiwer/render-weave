# 115 路获批后的正式交付

2026-11-03。用户在查看[试制说明](excel-production-proof-115.md)后明确回复“继续下一步，批准”。本次将批准写入正式审核轮次，应用完整候选，并按已展示的制作范围正式出图。验收状态与执行结果见[票据 08](../../.scratch/excel-agent-extraction/issues/08-approved-production-delivery.md)，决定见 M372。

## 批准范围与处理

- 使用前轮两份 `production-direction@2` 候选，完整保留两个方向各 32 站及 10 条批注。原件与候选内容不改。
- 沿用厘米尺寸、现有版式、96 dpi PNG；图片中的“试制待核准 · 不用于制作”改为制作尺寸说明，其他内容和布局不变。模板保存在原应用工作空间，未修改通用引擎。
- 本次制作 65 项：45 × 20.8 cm 为 18 项，52.5 × 13.5 cm 为 44 项，48 × 13.5 cm 为 2 项，89 × 27 cm 为 1 项。前三站两尺寸都制作，安装信息遵循原批注，不补写未指定位置。
- 两个缺尺寸终点本次暂不制作；原始数据和批注保留，计划显式记录原因。按方向与尺寸分成 7 组，组内不适用位置也必须显式排除，因此计划中的 159 条跳过记录不等于 159 个未制作站点。
- 批准依据记录用户原话、源哈希、制作范围及时间；审核由公开 `changeReview` 执行，随后 `applyAgentRound` 应用完整候选。正式准备与交付通过 `agent prepare-output` / `agent deliver-output`，没有绕过既有门槛。

## 本地成果

根目录：`F:\GenCode\render-weave-excel-prototype\out\excel-p07\930898314428416\final-01\`。

| 路径 | 用途 |
|---|---|
| `index.html` | 正式图片总览、尺寸/站名筛选及全部批注 |
| `115-production-images.zip` | 65 张 PNG、总览、制作清单、批准依据及验证摘要；解压后打开 index.html |
| `images/` / `manifest.json` | 便于取用的图片及原位置、批注、尺寸、交付记录目录映射 |
| `approval-basis.json`、`review-before.json`、`review-after.json`、`apply-result.json` | 用户授权与正式审核/应用结果 |
| `output-plan.json` / `prepared/` | 7 组计划、明确跳过原因及固定依赖 |
| `delivery/` | 正式批次、逐项图片与自足 `record.json` |
| `replay/` | 全量逐项重放结果 |
| `verification.json`、`browser-result.json`、`package-verification.json` | 独立内容检查、浏览器检查及压缩包完整性 |

图片 ZIP 不含字体和自足记录；要独立重放，使用 `delivery/<组>/<项>/` 的完整记录目录。示例：

```powershell
node dist/bin.js replay --record out/excel-p07/930898314428416/final-01/delivery/0001/0001 --out out/115-replay-new
```

原件 SHA-256：`469774248cc9055307c5430c6282417ba179e11000bc0e2e92531c8661a357e0`。应用回执 ID：`889abb6c-8a11-48af-a3fe-0585431f30df`。完整私有数据和图片保存在本地 out；分支 `feature/excel-agent-delivery` 只提交本轮文档，主检出仅同步文档。

## 后续边界

用户批准已落实为正式本地交付；前轮草稿和检查记录保持为历史证据。当前审批状态应查原审核轮次，不再用前轮静态报告判断实时状态。

人工业务审核工时、实际扣费仍为未知，本轮没有新增模型调用。实表技术交付完成不代表全部成本验收、生产隔离或旧模块完整替代完成。后续工程应将工作簿检查点接入正式 `agent run` 并收口生产隔离，按同一实表回归提取、审核、应用和交付链路。
