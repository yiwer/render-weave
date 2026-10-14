# RenderWeave

以数据定义、模板与数据集生成 PNG/JPEG 的 TypeScript 渲染引擎。首期已完成发布、校验、求值、布局、出图及命令行闭环，主要验收样例为 M402 公交线路牌。

## 运行样例

需要 Node.js 22 或以上版本。首次准备字体需要联网，字体版本和 SHA-256 固定在 `scripts/fonts.json`；渲染使用本地资源。

```powershell
npm ci
npm run fetch-fonts
npm run build
node dist/bin.js render --workspace docs/examples/m402-dsl --resources fixtures/resources --request docs/examples/m402-dsl/render-request-m402.json --out out/m402
```

成功时输出 `image.png`、`problems.json`、`layout.json`；默认样例为 3496 × 780 px、120 DPI。修改请求的 `parameters.currentIndex` 可以切换本站；`0` 表示不标本站。修改 `mode` 为 `draft` 可查看有问题的草稿。

渲染退出码：`0` 已出图（草稿可能仍有严重问题，须检查问题清单）；`1` 未出图或执行失败；`2` 参数或请求文件读取错误。再次使用同一输出目录会清除上次的图片、摘要和问题清单，避免旧成果被误认为本次成功。独立调用可并发；CLI 同一输出目录应串行使用。

## 发布静态数据定义

```powershell
node dist/bin.js publish --definition path/to/schema-example.json --workspace path/to/published --out path/to/published
```

`--workspace` 必须是已存在且可读取的工作区，首次发布使用空目录即可，无需资源清单。待发布的数据定义文件放在工作区外，省略 `version` 由发布自动递增；已有版本要完整保留在工作区中。发布生成带版本号的定义与编译产物，目标文件已存在则失败，不能覆盖。可捕获的写入错误会撤回本次创建的文件；本地文件发布不提供断电或进程强杀时的事务保证。

发布退出码：`0` 已发布；`1` 校验或写入失败；`2` 参数、定义文件读取或原始数字精度错误。失败原因写到标准错误流。

## 验证与文档

```powershell
npm test
npm run typecheck
npm run build
node scripts/accept-m402.mjs out/stage1/m402
node scripts/accept-stage1.mjs out/stage1/stability
```

- [阶段验收与 DSL 能力边界](docs/stage1-acceptance.md)：可靠性、鲁棒性、可用性结果及延期范围。
- [资源内容版本](docs/resources-versioning.md)：CLI 导入、替换影响检查、应用替换、查询旧版和固定版本出图。
- [批量正式交付、草稿预览与出图记录](docs/output-records.md)：35 项 M402 逐项交付、批量草稿、混合失败与退出码、模板调用与素材依赖、取消与中断辨认、同批去重、独立复制及确切构建重放。
- [M402 DSL 样例](docs/examples/m402-dsl/README.md)：可直接运行的 JSON 写法。
- [M402 外观验收](docs/examples/m402-acceptance.md)：参考图差异与场景结果。
- [草稿与正式模式](docs/render-modes.md)、[字体](docs/render-fonts.md)、[SVG](docs/render-svg.md)：问题处理和资源约定。
- [EAN/UPC 条形码](docs/render-retail-barcodes.md)、[商品编号样例](docs/examples/retail-barcode-dsl/README.md)：完整编号、校验位与格式专属留白。
- [CODE128 条形码](docs/render-barcode.md)、[资产编号样例](docs/examples/barcode-dsl/README.md)：资源字体、下方文字与独立解码验收。
- [二维码](docs/render-qrcode.md)、[查询码样例](docs/examples/qrcode-dsl/README.md)：文本绑定、可执行命令与最终图片解码验证。
- [CONTEXT.md](CONTEXT.md)：开发接续入口与文档地图。

二维码、CODE128、EAN/UPC、资源版本导入与替换、批量正式交付与草稿预览（1–1,000 项串行）、记录重放、项间取消与中断后辨认、同批素材硬链接去重，以及码图模板的交付与重放已在第二阶段票据 01–12 实现；服务、MCP、业务 Agent、OCR、在线编辑器仍未实现。记录支持完整 M402、PNG/JPEG/WebP/SVG 与字体，码图交付与 URL 图片仍后置。领域模型文档包含未来设计，当前可执行能力以首期阶段验收、已完成的第二阶段票据及对应 DSL 样例为准。
