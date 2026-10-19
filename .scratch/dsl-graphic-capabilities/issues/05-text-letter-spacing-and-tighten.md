# 05: 文本支持固定字间距 `letterSpacing` 与横排收紧字距适配

**What to build:** 模板作者与 Agent 可为文本元素设置常态字间距 `letterSpacing`（支持正负毫米值与变量绑定），并在横排文本 `fit.steps` 中使用 `"tightenSpacing"` 在压缩字形前先收紧字距。

**Blocked by:** 无

**Status:** ready-for-agent

**Trace:** [父规格](../spec.md)；ADR-0016（DSL 1.x 只做加法）；验收 A01、A02、A06。

- [ ] DSL 与静态检查：
  - 文本元素新增可选 `"letterSpacing": 毫米或数值变量`（有限数值，可正可负，缺省 `0`；不设跨字段的字号比例限制，以免与变量绑定或片段字号冲突）；
  - 横排文本（`writingMode: "horizontal"`）的 `fit.steps` 允许包含 `"tightenSpacing"`，顺序须排在 `"compressGlyphs"` 与 `"shrink"` 之前（即允许 `["tightenSpacing"]`、`["tightenSpacing", "compressGlyphs"]`、`["tightenSpacing", "compressGlyphs", "shrink"]`，与竖排顺序一致）。
- [ ] 测量与排版：
  - 非分布对齐（横排 `start`/`center`/`end`，竖排 `top`/`center`/`bottom`）下，相邻字形（跨片段连续计算）之间额外加上 `letterSpacing`（单字或空文本不加），自然宽度（横排）或自然高度（竖排）对 `0` 取下限（`Math.max(0, …)`），布局摘要中的 `spacing` 记录实际生效的字间距；
  - 两端分布（`distribute`、`spaceEvenly`）下，自然跨度不含 `letterSpacing`，余宽均分后的字距不小于 `0`；
  - 当横排或竖排配置了 `"tightenSpacing"` 且在 `letterSpacing > 0` 下超出可用宽/高时，先将字距从 `letterSpacing` 线性收紧至最低 `0`；若收紧到 `0` 仍放不下（或原本 `letterSpacing <= 0`），再依次执行后续的 `"compressGlyphs"` 与 `"shrink"`。
- [ ] 合同与参考同步：
  - 更新模板 JSON Schema、人读参考（含 `docs/dsl/README.md`「1.0 之后的变化」）与 Agent 参考的文字章节及可绑定数值列表；
  - 一致性测试覆盖 `letterSpacing`（字面值与变量绑定）及横排 `tightenSpacing` 步骤顺序的正向与错误变异样本。
- [ ] 测试与验收：
  - 验证正负 `letterSpacing` 的自然尺寸测量、字形位置与布局摘要 `spacing`，以及横排先收紧字距再压缩字形的边界行为；
  - 现有全部语料、M402 共享样例、golden 与布局快照保持不变；Windows 与 Linux 全量测试通过，记录 M 编号并同步 `CONTEXT.md`。

**测试接缝：** 从公开渲染入口 `render` 与文档检查入口 `checkDslDocument` 进入；DSL 一致性测试在 `test/dsl-template-schema.test.ts`。
