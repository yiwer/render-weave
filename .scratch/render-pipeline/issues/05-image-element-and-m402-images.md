# 05: 图片元素与 M402 图片资源

**What to build:** 图片元素显示资源仓库中的 PNG、JPEG、WebP 图片，并支持三种适配方式；同时建好 M402 用到的图片资源夹具，供 07、08 与端到端验收使用。SVG 不在本票（见 13）。

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] 图片元素的来源为资源引用（`res:资源ID`，资源仓库由 01 提供）；支持 PNG、JPEG、WebP；适配方式支持完整显示、铺满裁剪与拉伸。
- [ ] 引用不存在的资源，或在图片位置引用了字体资源时，返回以元素路径定位的问题。
- [ ] M402 图片资源夹具按 DSL 草稿中的资源 ID 建好：`route-no-m402`、`landmark-1` 至 `landmark-4`、`icon-metro`、`icon-hospital`，格式为 PNG；夹具的来源（从设计稿裁出或另行绘制）写在夹具目录的说明里。
- [ ] golden 图片测试覆盖三种适配方式。
