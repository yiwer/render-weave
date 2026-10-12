# 13: SVG 图片

**What to build:** 图片元素可以显示资源仓库中的 SVG 图片，按出图分辨率栅格化，不出现模糊。M402 不需要 SVG，本票不阻塞端到端验收，可在任何时候插入。

**Blocked by:** 05

**Status:** resolved

- [x] 资源仓库接受 SVG 图片资源；图片元素显示 SVG 时，按元素框的像素尺寸栅格化，放大不模糊。
- [x] SVG 加载时去除脚本与外部引用（含外部图片、字体与样式表）；SVG 中的文字只使用资源仓库中的字体，不使用系统字体（M99）。
- [x] 两套参考引擎都不支持 SVG，需要单独的 SVG 栅格化方案（如 resvg）；选型写明理由，并确认它在 Windows 与 Linux 上输出一致。这是本票的风险点。
- [x] 三种适配方式对 SVG 同样适用。
- [x] SVG 无法解析时返回以元素路径定位的问题。
- [x] golden 图片测试覆盖 SVG 的三种适配方式与高 DPI 输出。

## Answer

采用 resvg WASM 2.6.2；XML/CSS 先清理，资源字体转路径，排版后按实际尺寸及 DPI 栅格化，交给现有 CanvasKit 合成。Windows/Linux 的四份 PNG/JPEG 文件 SHA-256 全部一致。选型与取舍见 [ADR-0012](../../../docs/adr/0012-svg-resvg-wasm.md)，配置、边界与复现见 [SVG 图片](../../../docs/render-svg.md)。

## Comments

**实施完成，用户已确认提交。** `CI=1 npm test`：16 个文件、330 个用例通过；`npx tsc --noEmit --noUnusedLocals --noUnusedParameters`、`npm run build`、`git diff --check` 通过。

- `src/svg.ts` 负责结构化清理、WASM 初始化、资源字体加载和 SVG 栅格化；不读外部文件、网络或系统字体。缺可用字体、损坏 SVG、栅格超限均返回元素问题。
- `src/images.ts` 在布局后按显示像素密度生成和缓存位图，支持 contain/cover/fill、多尺寸复用；中间资源在出图结束释放。草稿与正式使用相同诊断。
- 新增 17 个测试，覆盖三种适配的两个 DPI golden、中文字体 golden、细线清晰度、天然尺寸、脚本/外部引用/CSS 转义清理、内嵌位图、损坏字体、解析失败与极端宽高比。
- 实测 Windows x64（Node v24.12.0）与 Linux x64（Docker node:22-alpine，Node v22.23.3），127/508 DPI × PNG/JPEG 共四份文件逐字节一致；命令与完整哈希已录入使用说明。结果位于 `out/ticket13/windows/`、`out/ticket13/linux/`。
- 已目视核对高 DPI 三种适配图、中文字体图与跨平台综合图。未修改模板 DSL 或共享 M402 数据集；新增决定 M144–M145，下一票据 14 为完整 M402 验收。
