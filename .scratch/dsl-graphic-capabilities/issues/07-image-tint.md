# 07: 图片元素支持 `tint` 单色重染

**What to build:** 模板作者与 Agent 可在 `image` 元素上设置可选的 `tint` 颜色属性（支持绑定颜色变量与状态样式覆盖），将单色图标或地标图片按目标颜色重染输出，无需为不同状态维护多套同形异色的图片资源。

**Blocked by:** 无

**Status:** resolved

**Trace:** [父规格](../spec.md)；ADR-0016（DSL 1.x 只做加法）；验收 A01、A02、A07。

- [x] DSL 与静态检查：
  - `image` 元素新增可选属性 `"tint": "#RRGGBB" | "#RRGGBBAA" | { "var": 颜色变量 }`，并允许在 `states` 状态样式中覆盖 `tint`；
  - 静态检查核对 `tint` 绑定的变量类型为 `color`；求值时若绑定的颜色变量缺值，按无 `tint`（保持原图颜色）处理或透明处理规则在参考文档中写明并保持一致（拍板：缺值时与其余颜色绑定一致取透明 `#00000000`；未写 `tint` 键时保持原图本色）。
- [x] 布局摘要与绘制：
  - 布局摘要 `ImageSummary` 在设置了 `tint` 时记录规范化后的 `tint` 颜色值（`#RRGGBBAA`），未设置时不增加该键（保持已有布局快照不变）；
  - 绘制位图（PNG/JPEG/WebP）与栅格化后的 SVG 时，若存在 `tint`，使用 `srcIn` 颜色滤镜以 `tint` 颜色替换原图像素 RGB 并乘算 `tint` 的 Alpha 与原图 Alpha 通道。
- [x] 合同与参考同步：
  - 更新模板 JSON Schema、人读参考（含 `docs/dsl/README.md`「1.0 之后的变化」）与 Agent 参考的图片元素章节与可绑定颜色属性表；
  - 一致性测试覆盖 `tint` 字面值、变量绑定、状态样式覆盖及非法颜色格式变异样本。
- [x] 测试与验收：
  - 验证同一地标/图标资源在原色、本站红色 `tint`、已过站灰色 `tint` 状态下的像素颜色、透明度与布局摘要；
  - 现有全部语料、M402 共享样例、golden 与布局快照保持不变；Windows 与 Linux 全量测试通过，记录 M 编号并同步 `CONTEXT.md`。

**测试接缝：** 从公开渲染入口 `render` 与文档检查入口 `checkDslDocument` 进入；DSL 一致性测试在 `test/dsl-template-schema.test.ts`。

## Answer

- **完成日期**：2026-10-19
- **决定记录**：`M245`（`docs/discovery/requirements.md`）
- **验证命令与结果**：
  - `npm run typecheck`：0 错误
  - `npm run build`：通过
  - `npx vitest run test/image.test.ts test/dsl-template-schema.test.ts`：2 个测试文件、44 项测试全部通过
  - `npm test`：39 个测试文件、839 项测试全部通过，现有语料、M402 共享样例、已有 golden 与布局快照保持不变
- **成果路径**：
  - 引擎实现：`src/template/model.ts`、`src/template/parse.ts`、`src/layout/types.ts`、`src/layout/image.ts`、`src/mcp/tools.ts`、`src/draw.ts`
  - 契约与参考：`schemas/template.schema.json`、`docs/dsl/template.md`、`docs/dsl/README.md`、`agent/reference/template.md`
  - 测试：`test/image.test.ts`、`test/dsl-template-schema.test.ts`
- **验收偏差**：无（Agent 评估门槛按父规格 A08 在整批票据收尾时统一复跑）。
