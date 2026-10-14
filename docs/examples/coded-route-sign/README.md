# 带码线路牌扩展样例

在 M402 线路牌右侧加一块码区：上方是实时查询二维码，下方是资产条形码。用来验证码图模板的批量正式交付、出图记录与换素材后的历史重放（第二阶段票据 12）。

- [模板](template-coded-route-sign.json)：`带码线路牌`，以 `线路牌 v1` 为基准。左列以当前数据调用 M402 的 `标准线路单边`，右列码区宽 110 mm，整块 850 × 165 mm。
- [批量请求](batch-request.json)：6 项，数据集均为 `ds-m402-wanguocheng`。

模板参数全部是对外文本或数值，不新增静态数据定义，也不改 M402 数据集：

| 参数 | 作用 |
|---|---|
| `currentIndex` | 本站序号，传给 `标准线路单边` |
| `queryUrl` | 二维码内容，只编码为文本，不访问网络 |
| `assetNo` | 条形码内容，按文本保留前导零 |
| `assetFormat` | 条形码格式，经状态样式选择 `CODE128`、`EAN-13`、`EAN-8`、`UPC-A`；格式本身不绑定变量 |

条形码下方文字使用 `res:font-hei-regular`。M402 不使用这一字重，所以替换它只改变码区文字，便于核对换素材的效果。

## 运行

模板调用 M402 的模板，需要和 M402 的共享 JSON 放在同一个工作区。下面在临时目录合成工作区，不改动 `docs/examples/m402-dsl/`：

```powershell
npm run build
New-Item -ItemType Directory out/coded-workspace | Out-Null
Copy-Item docs/examples/m402-dsl/*.json out/coded-workspace/
Copy-Item docs/examples/coded-route-sign/template-coded-route-sign.json out/coded-workspace/
node dist/bin.js resources-init --resources out/coded-resources
node dist/bin.js resources-import --source fixtures/resources --resources out/coded-resources
node dist/bin.js deliver --workspace out/coded-workspace --resources out/coded-resources --request docs/examples/coded-route-sign/batch-request.json --out out/coded-batch
```

结果：

- 5 项交付成功：二维码配合四类条形码，其中最后一项输出 JPEG。
- `bad-ean13-checksum` 的编号末位校验位错误，以 `barcode.checksumInvalid` 失败，没有图片和记录。
- 因此退出码为 1。

换条形码字体并验证历史重放，见[出图记录说明](../../output-records.md)「票据 12 验收」。
