---
status: accepted
---

# SVG 用 resvg WASM 解码，按最终显示尺寸栅格化后交给 CanvasKit 合成

SVG 是图片资源，采用固定版本 `@resvg/resvg-wasm` 2.6.2；加载时先清理 XML/CSS，只传入资源仓库的字体，把文字转换成路径，排版结束后按实际显示尺寸与出图 DPI 栅格化，再沿用 CanvasKit 的裁剪、透明度、旋转和图片编码。这样保持 ADR-0011 的最终绘制后端，同时让 SVG 的解码、字体选择与像素生成在 Windows、Linux 使用同一份 WASM；[resvg 官方项目](https://github.com/thx/resvg-js)提供纯 WASM 版本和内存字体输入。

没有选择平台原生的 resvg 绑定，是为了避免增加平台二进制分发与不同构建的验证组合；没有引入浏览器截图，是为了保持当前无浏览器的渲染入口与封闭资源读取边界。代价是增加一份 WASM、XML/CSS 清理依赖，以及 SVG 中间位图的内存和解码成本；每次出图内按资源与目标栅格宽度复用中间位图，文字只转路径一次，渲染结束释放。替换 SVG 渲染器可能改变滤镜、字体轮廓与 golden，后续升级须重新进行跨平台验证。

已实测 Windows x64（Node v24.12.0）与 Linux x64（Docker `node:22-alpine`，Node v22.23.3）：包含渐变、裁剪、细线、三种图片适配和两种字重中文的 127/508 DPI PNG/JPEG 共四份文件 SHA-256 完全相同。该结论覆盖已测样例，复现命令与哈希见 [SVG 图片](../render-svg.md)。
