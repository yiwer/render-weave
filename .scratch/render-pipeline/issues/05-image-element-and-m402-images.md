# 05: 图片元素与 M402 图片资源

**What to build:** 图片元素显示资源仓库中的 PNG、JPEG、WebP 图片，并支持三种适配方式；同时建好 M402 用到的图片资源夹具，供 07、08 与端到端验收使用。SVG 不在本票（见 13）。

**Blocked by:** 01

**Status:** resolved

- [x] 图片元素的来源为资源引用（`res:资源ID`，资源仓库由 01 提供）；支持 PNG、JPEG、WebP；适配方式支持完整显示、铺满裁剪与拉伸。
- [x] 引用不存在的资源，或在图片位置引用了字体资源时，返回以元素路径定位的问题。
- [x] M402 图片资源夹具按 DSL 草稿中的资源 ID 建好：`route-no-m402`、`landmark-1` 至 `landmark-4`、`icon-metro`、`icon-hospital`，格式为 PNG；夹具的来源（从设计稿裁出或另行绘制）写在夹具目录的说明里。
- [x] golden 图片测试覆盖三种适配方式。

## Comments

**2026-10-10 实施完成。** `npm test` 7 个文件 120 个用例全过（新增 12 个；CI 模式下 golden 只比对不改写），`npm run typecheck` 无错误（生成脚本也纳入了类型检查）。

实现要点：

- 图片元素：模型与解析在 `src/template/`，加载与格式识别在 `src/images.ts`（`ImageStore`，按文件头识别 PNG、JPEG、WebP，SVG 给出"尚未支持"），适配在 `src/layout/image.ts`：源区域与目标区域在排版时决定，绘制只按记录执行；布局摘要的图片项给出天然像素尺寸与实际画出的区域。
- 适配方式的验证用带 10 像素黑边的四色测试图：完整显示四边黑边都在且有留白，铺满裁剪裁掉左右黑边、保留上下，拉伸四边都在；PNG、JPEG、WebP 三种格式各测一遍。
- M402 图片夹具在 `fixtures/resources/images/`，由 `scripts/make-image-fixtures.ts` 生成：线路号从设计稿裁出（x 205–670、y 15–152 像素）并按橙色底色反解透明度；地标用思源黑体的 ①–④ 绘制；地铁、医院为示意图标。来源写在 `fixtures/resources/images/README.md`。
- 渲染前只加载会显示的元素用到的字体与图片，隐藏元素的子元素也跳过。
- 规则见 M114，写法见 DSL 草稿 README 的 S22。

已知限制：线路号图片由 120 DPI 的设计稿裁出，放大到 254 DPI 时边缘略软，白边外有一圈很淡的暖色；设计稿中地标随站点状态变色，夹具只有深灰一种。
