# 04: 矢量图形（路径、多边形、线条）支持 `viewBox` 随元素框缩放

**What to build:** 模板作者与 Agent 可为 `path`、`polygon`、`line` 声明可选的 `viewBox` 与缩放适配方式，使异形底框、装饰波浪带、箭头等矢量图形在画板或容器尺寸变化时自动随元素框缩放。

**Blocked by:** 无

**Status:** resolved

**Trace:** [父规格](../spec.md)；M94（未声明 `viewBox` 时坐标按毫米不拉伸）；ADR-0016（DSL 1.x 只做加法）；验收 A01、A02、A05。

- [x] DSL 与静态检查：
  - `path`、`polygon`、`line` 新增可选属性 `"viewBox": [minX, minY, width, height]`（4 个有限数值，`width > 0` 且 `height > 0`）与可选 `"fit": "fill" | "contain" | "cover"`（缺省 `"fill"`，仅在声明了 `viewBox` 时允许写 `fit`）；
  - 未声明 `viewBox` 时写了 `fit`、或 `viewBox` 宽高不大于 0 时，Schema 或静态检查拒绝并给出明确原因。
- [x] 测量、排版与绘制：
  - 未声明 `viewBox` 时，完全保持 M94 行为：坐标以毫米计、相对元素框左上角，框变大时不拉伸；
  - 声明了 `viewBox` 时：随内容（`"hug"`）的自然尺寸取 `viewBox` 的 `width` 与 `height`（像图片一样，若只固定了宽或高一边且 `fit` 为 `contain`/`cover`，另一边按 `viewBox` 宽高比换算）；实际绘制时将 `viewBox` 的 `[minX, minY, width, height]` 区域按 `fit`（`fill` 拉伸填满、`contain` 等比居中完整显示、`cover` 等比居中铺满并裁剪到元素框）映射变换到 `ck.Path` 的几何顶点上；
  - 通过变换路径几何顶点而非缩放画布绘制，确保描边宽度（`stroke.width`）与虚线（`stroke.dash`）始终保持声明的毫米值，不因非等比拉伸而发生横纵粗细变形。
- [x] 合同与参考同步：
  - 更新模板 JSON Schema（用 `exclusiveMinimum: 0` 与 `dependentRequired` 约束 `viewBox` 与 `fit`）、人读参考（含 `docs/dsl/README.md`「1.0 之后的变化」）与 Agent 参考的图形元素章节；
  - 一致性测试覆盖 `viewBox` 与 `fit` 的正向语料与结构错误变异样本。
- [x] 测试与验收：
  - 验证同一带 `viewBox` 的异形底框与箭头模板在 740 mm 与 1500 mm 两种画板宽度下自动拉伸适配且描边均匀；
  - 现有全部语料、M402 共享样例、golden 与布局快照保持不变；Windows 与 Linux 全量测试通过，记录 M 编号并同步 `CONTEXT.md`。

**测试接缝：** 从公开渲染入口 `render` 与文档检查入口 `checkDslDocument` 进入；DSL 一致性测试在 `test/dsl-template-schema.test.ts`。

## Answer

- **完成日期**：2026-10-19
- **决定记录**：`M242`（`docs/discovery/requirements.md`）
- **验证命令与结果**：
  - `npm run typecheck`：0 错误
  - `npm run build`：通过
  - `npx vitest run test/layout.test.ts test/dsl-template-schema.test.ts`：2 个测试文件、61 项测试全部通过
  - `npx vitest run`：39 个测试文件、810 项测试全部通过，现有语料、M402 共享样例、golden 与已有布局快照无变化
- **成果路径**：
  - 引擎实现：`src/template/model.ts`、`src/template/parse.ts`、`src/dsl-schema.ts`、`src/layout/types.ts`、`src/layout/shapes.ts`、`src/draw.ts`
  - 契约与参考：`schemas/template.schema.json`、`docs/dsl/template.md`、`docs/dsl/README.md`、`agent/reference/template.md`
  - 测试：`test/layout.test.ts`、`test/dsl-template-schema.test.ts`
- **验收偏差**：无（Agent 评估门槛按父规格 A08 在整批票据收尾时统一复跑）。
