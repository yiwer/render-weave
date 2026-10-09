---
status: accepted
---

# 渲染引擎用 TypeScript 实现，不依赖框架；Skia 栅格化、ajv 校验、自研布局

渲染引擎（数据定义、数据集校验、模板、求值、排版、栅格化）用 TypeScript 在 Node 22 上实现，作为一组不依赖任何框架的模块，并提供命令行入口。数据集校验用 ajv（JSON Schema 2020-12，注册 `rw-time` 等自定义格式）；栅格化与文字排版基于 Skia（CanvasKit 或 skia-canvas），竖排与字形压缩若段落排版做不到则按字形逐个排版（如 HarfBuzz）；自由、堆叠、网格三种布局自行实现，可参考 design-layout-draw 的思路但不复用其代码。

选择 TypeScript，是为了让日后的在线编辑器在浏览器中预览时与服务端共用同一套求值与排版引擎，MCP 也有官方 TypeScript SDK，design-layout-draw 已验证"TypeScript 布局 + CanvasKit 出图"可行。rid-rs 与旧 RenderWeave 的服务端用 Java、CloudKiln 用 Python，未被采用。引擎不使用 NestJS：本期没有 HTTP 服务与依赖注入需求，且引擎要被编辑器、MCP 服务与 HTTP 服务共同调用；服务外壳在后续一期选型，NestJS 是合理默认但不进入引擎。若批量出图性能不足，再考虑把栅格化换成 Rust。

依据：2026-10-09 实施规划讨论，规格见 `.scratch/render-pipeline/spec.md`。
