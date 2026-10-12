# 查询码独立样例

模板以内置“空数据定义 v1”为基准，渲染请求提供 `queryUrl` 文本参数，无需新建静态数据定义或修改 M402 数据集。查询网址使用示例域名，出图时不访问网络。

- [模板](template-query.json)
- [渲染请求](render-request-query.json)
- [DSL、诊断与验证说明](../../render-qrcode.md)

在仓库根目录运行：

```powershell
npm run build
node dist/bin.js render --workspace docs/examples/qrcode-dsl --resources fixtures/resources --request docs/examples/qrcode-dsl/render-request-query.json --out out/stage2/qr-cli
```

输出为 60 × 60 mm、120 DPI 的 PNG（283 × 283 px），附问题清单和布局摘要。二维码放在 50 × 50 mm 框内；修改请求的 `queryUrl` 即可换内容。改为 `format: "jpeg"` 或 `dpi: 300` 可验证其他输出设置；本样例画板尺寸固定为 60 × 60 mm。

将网址改为空文本：正式返回退出码 1、`qrcode.contentInvalid` 且不保留上次图片；改为 `mode: "draft"` 可看到问题位置，但不会生成貌似有效的占位码。
