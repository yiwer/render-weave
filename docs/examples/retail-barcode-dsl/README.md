# EAN/UPC 商品编号示例

三份独立模板使用同一文本参数 `productId`，必须提供完整编号，含前导零及校验位。出图与失败合同见 [EAN/UPC 说明](../../render-retail-barcodes.md)。

| 格式 | 模板 | 请求 | 扫码编号 |
|---|---|---|---|
| EAN-13 | [template-ean13.json](template-ean13.json) | [render-request-ean13.json](render-request-ean13.json) | `0012345678905` |
| EAN-8 | [template-ean8.json](template-ean8.json) | [render-request-ean8.json](render-request-ean8.json) | `01234565` |
| UPC-A | [template-upca.json](template-upca.json) | [render-request-upca.json](render-request-upca.json) | `012345678905` |

在仓库根目录运行：

```powershell
npm run fetch-fonts
npm run build
node dist/bin.js render --workspace docs/examples/retail-barcode-dsl --resources fixtures/resources --request docs/examples/retail-barcode-dsl/render-request-ean13.json --out out/stage2/retail-cli/ean13
node dist/bin.js render --workspace docs/examples/retail-barcode-dsl --resources fixtures/resources --request docs/examples/retail-barcode-dsl/render-request-ean8.json --out out/stage2/retail-cli/ean8
node dist/bin.js render --workspace docs/examples/retail-barcode-dsl --resources fixtures/resources --request docs/examples/retail-barcode-dsl/render-request-upca.json --out out/stage2/retail-cli/upca
```

每个目录输出 `image.png`（307 × 198 px，120 DPI）、`layout.json` 和空问题清单。将 `showText` 改为 `false` 隐藏下方文字；请求支持 300 DPI 和 `jpeg`。

删掉一位、输入非数字或更改校验位，正式模式都会拒绝并清除上次图片；`mode: draft` 输出错误位置框。不会自动补位或修改编号。

`node scripts/accept-retail-barcodes.mjs out/stage2/retail-windows` 一次生成 24 份出图，覆盖三格式、文字开关、120/300 DPI、PNG/JPEG，独立解码并记录完整字节。部分扫码工具会将 UPC-A 显示成补一个零的 EAN-13 表示，示例的原始 12 位参数和下方文字保持不变。
