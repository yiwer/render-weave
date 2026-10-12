# SVG 图片

SVG 与 PNG、JPEG、WebP 共用图片元素和资源仓库：在 `resources.json` 登记 `kind: "image"`，元素写 `source: "res:资源ID"`。模板 DSL 与渲染请求无需增加属性；`contain`、`cover`、`fill` 的语义沿用位图。

加载 SVG 时读取天然尺寸，SVG 单位按 96 DPI 换算；只有 `viewBox` 的图片也可求出宽高。随内容尺寸沿用图片元素的规则。排版完成后，按实际显示尺寸和出图 DPI 生成位图：`cover` 使用裁剪前的整图尺寸，`fill` 取两轴中较高的像素密度。同一资源在不同尺寸下分别缓存，本次渲染结束释放；布局摘要中的 `naturalWidth`、`naturalHeight` 保留天然尺寸，不随出图 DPI 改变。

## 字体与加载边界

SVG 中的字体名称按字体文件内部的 family/weight 选择，只能使用资源仓库中的字体。引擎第三参数可配置候选资源 ID（不带 `res:`）：

```ts
await render(workspace, request, {
  svgFonts: ['font-hei-regular', 'font-hei-bold'],
});
```

缺省为 `font-hei-regular`、`font-hei-medium`、`font-hei-bold`、`font-hei-heavy`。配置与模板文字的 `fallbackFonts` 独立；SVG 文字由 resvg 排版并转换成路径，不进入模板文本元素的逐字替代摘要。未找到指定 family 时只在这些资源字体中选取；不读取系统字体。有文字而无可用候选字体时返回严重问题。未安装、读不到、损坏或种类不符的候选跳过。

SVG 输入为 UTF-8 XML。加载阶段拒绝 DOCTYPE/实体声明、畸形 XML 和错误根元素；移除脚本、事件、动画、外来命名空间元素及 `foreignObject`，移除 XML 样式表处理指令、CSS at-rule（含 `@import`、`@font-face`）。XML 属性和 CSS 值经过结构化解析，清除外部 URL，保留 `#id` 内部引用；图片可内嵌 PNG/JPEG/WebP 的 base64 数据，不允许嵌套 data SVG。普通内部 CSS、渐变、裁剪及静态滤镜由 resvg 处理，不请求外部图片、字体或样式表。

解析或栅格化失败报 `resource.unreadable`，定位到使用资源的元素。SVG 中间位图遵守单边 20,000 像素、总量 100,000,000 像素的上限；例如极端宽高比的 `cover` 可能在画板尺寸合法时仍超过中间位图限制。正式出图存在严重问题时无图片；草稿跳过失败图片并标记问题框，两种模式使用相同诊断。

## 验证与复现

`test/svg.test.ts` 覆盖三种适配、多尺寸复用、127/508 DPI golden、放大后仅 0.25 SVG 单位宽的清晰窄线、天然尺寸、资源字体、恶意引用清理、内嵌位图、畸形输入和栅格上限。新增 golden 已目视核对：`svg-fits-127.png`、`svg-fits-508.png`、`svg-resource-font.png`。

跨平台脚本通过公开渲染入口出图。先准备字体与构建，然后在 PowerShell 运行：

```powershell
npm run fetch-fonts
npm run build
node scripts/check-svg-platform.mjs out/ticket13/windows
docker run --rm -v "${PWD}:/work" -w /work node:22-alpine node scripts/check-svg-platform.mjs out/ticket13/linux
Compare-Object (Get-Content out/ticket13/windows/hashes.json) (Get-Content out/ticket13/linux/hashes.json)
```

本次实测：Windows x64 / Node v24.12.0，Linux x64 / Node v22.23.3。最后一条命令无差异；四份文件都包含三种适配、内部样式、渐变、裁剪、细线、中文常规与粗体字。

| 文件 | 两平台相同的 SHA-256 |
|---|---|
| `svg-127.png` | `04f4b2955e0f61af7ef1dd4af49b97e5e427a71f0c5f5f022708f34d7a825e06` |
| `svg-127.jpeg` | `545e1c63ef8a624637940925cd9995950460ea3537f97022c0e48cf30615a55d` |
| `svg-508.png` | `2049380aa065bd48ef8bf8c984305e70ec5a90b20a90e11fdafaf7c3f19e1bf9` |
| `svg-508.jpeg` | `211c75ffc2673b7e488eb2dcde439149145983e5a53d2f8bee546de9071e5c62` |
