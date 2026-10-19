# M162 竖版站台线路牌：票据 09 真人走查的材料

2026-10-18 内部成员照[代建指南](../../../../docs/agent-guide.md)走查用的材料，记录见[第三阶段验收](../../../../docs/stage3-acceptance.md#真人走查a11-补测)。

- **示例图**：不进版本库。1654 × 4488 像素 PNG（350 × 950 mm，120 DPI），SHA-256 `8057fd4cff33f9634696267bfd48176933980e787e01429dbb7e60a202ac02ba`。
- **项目说明**：`brief-definition.md`、`brief-dataset.md`、`brief-template.md`，后两份只比第一份多一行"命名"。
- **出图请求**：`request.json` 用于模板辅助设计；`batch.json` 用于正式出图，共三张：本站 1、不标本站、本站 10。
- **设施图标**：`icons/` 下四个手绘 SVG，是示意图标，不是官方标志。走查时复制 `fixtures/resources`，把它们放进 `images/m162/`，并在 `resources.json` 里登记为 `facility-hospital`、`facility-metro`、`facility-railway`、`facility-airport`（`kind: "image"`）。正式出图前再用 `resources-init` 与 `resources-import` 导入版本仓库。
