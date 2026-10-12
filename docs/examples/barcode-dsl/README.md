# CODE128 资产编号示例

独立工作区通过文本参数 `assetId` 生成 CODE128，下方文字使用资源字体。模板位于 [template-asset.json](template-asset.json)，请求位于 [render-request-asset.json](render-request-asset.json)，完整合同见 [条形码说明](../../render-barcode.md)。

在仓库根目录运行：

```powershell
npm run fetch-fonts
npm run build
node dist/bin.js render --workspace docs/examples/barcode-dsl --resources fixtures/resources --request docs/examples/barcode-dsl/render-request-asset.json --out out/stage2/code128-cli
```

输出 `image.png`（567 × 213 px，120 DPI）、`layout.json` 和空的 `problems.json`。扫码内容为 `RW-M402-000123`；改 `parameters.assetId` 即可更换编号，保留前导零。

将模板中的 `showText` 改为 `false` 可隐藏下方文字；请求的 `output.dpi` 改为 300，`output.format` 改为 `jpeg`，即可生成其他规格。空串、中文或过窄的框会使正式请求返回非零退出码并清除旧图；请求 `mode` 改为 `draft` 时输出问题框，不画伪造或部分有效条码。

批量生成本票的 8 份验收示例：`node scripts/accept-barcode.mjs out/stage2/code128-windows`。脚本分别覆盖显示/隐藏文字、120/300 DPI、PNG/JPEG，并使用独立 ZXing 解码器读回原编号。
