# 06: 竖排文本支持文本片段独立字体字号与竖排标点旋转

**What to build:** 模板作者与 Agent 可在竖排文本的各个文本片段上单独设置 `font` 与 `fontSize`（实现同列主站名大字、括号副站名小字并共同参与两端分布），且竖排中的 CJK 括号、破折号等标点自动旋转为竖排方向。

**Blocked by:** 05

**Status:** resolved

**Trace:** [父规格](../spec.md)；ADR-0016（DSL 1.x 只做加法）；验收 A01、A02、A06。

- [x] DSL 与静态检查：
  - 放开竖排文本（`writingMode: "vertical"`）的文本片段与变量插槽只能单独设 `color` 的限制，允许单独设置 `font` 与 `fontSize`（`slant` 仍只用于横排，竖排片段写 `slant` 继续报错）；
  - 竖排缩字组（`widthOverflow.shrinkGroup`）生效时，按比例同步缩放竖排文本内各片段的 `fontSize`（与横排 `shrink` 缩放各片段一致）。
- [x] 竖排测量、排版与标点旋转：
  - 竖排每个字形按所属片段的字体与字号计算各自字格高度（`ascent + descent`），整列宽度取有字片段中最大 `fontSize`（无字时取元素 `fontSize`），每个字形在列宽内水平居中；
  - 两端分布（`verticalAlign: "distribute"`）、收紧字距与纵向压缩字形按各字形的实际字格高度之和计算；
  - 对竖排常见方向性标点（全角括号 `（）〔〕【】《》〈〉「」『』`、破折号 `—`、省略号 `…`、波浪号 `～`、间隔号等），当字体未提供原生竖排字形替换时，绕字格中心顺时针旋转 90° 绘制并按旋转后的墨迹边界参与竖排两端分布计算。
- [x] 合同与参考同步：
  - 更新模板 JSON Schema、人读参考（含 `docs/dsl/README.md`「1.0 之后的变化」）与 Agent 参考的文字章节及「已知限制」；
  - 一致性测试与 `test/text.test.ts` 更新竖排片段样式的用例与变异样本（竖排片段设 `font`/`fontSize` 改为合法，设 `slant` 仍拒绝）。
- [x] 测试与验收：
  - 验证“主站名 10 mm 粗体 + `（北门）` 7 mm 常规体”在同一竖排文本元素内两端分布、括号旋转 90°、以及参与缩字组时的布局摘要与 golden 出图；
  - 现有全部语料、M402 共享样例、已有 golden 与布局快照保持不变（已有语料经核查竖排均无片段级字号/字体或需旋转标点）；Windows 与 Linux 全量测试通过，记录 M 编号并同步 `CONTEXT.md`。

**测试接缝：** 从公开渲染入口 `render` 与文档检查入口 `checkDslDocument` 进入；DSL 一致性测试在 `test/dsl-template-schema.test.ts`。

## Answer

- **完成日期**：2026-10-19
- **决定记录**：`M244`（`docs/discovery/requirements.md`）
- **验证命令与结果**：
  - `npm run typecheck`：0 错误
  - `npm run build`：通过
  - `npx vitest run test/vertical.test.ts test/text.test.ts test/shrink-groups.test.ts test/dsl-template-schema.test.ts`：4 个测试文件、107 项测试全部通过
  - `npm test`：39 个测试文件、835 项测试全部通过，现有语料、M402 共享样例、已有 golden 与布局快照保持不变
- **成果路径**：
  - 引擎实现：`src/template/parse.ts`、`src/text/shape.ts`、`src/text/vertical.ts`、`src/layout/text.ts`、`src/layout/types.ts`、`src/layout/shrink-groups.ts`、`src/layout/index.ts`、`src/draw.ts`
  - 契约与参考：`schemas/template.schema.json`、`docs/dsl/template.md`、`docs/dsl/README.md`、`agent/reference/template.md`
  - 测试与 Golden：`test/vertical.test.ts`、`test/text.test.ts`、`test/shrink-groups.test.ts`、`test/dsl-template-schema.test.ts`、`test/golden/vertical-fragments-punctuation.png`
- **验收偏差**：无（Agent 评估门槛按父规格 A08 在整批票据收尾时统一复跑）。
