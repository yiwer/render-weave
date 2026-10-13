# EAN/UPC：完整商品编号与校验位

第二阶段票据 03 在原有 `barcode` 元素上增加 `EAN-13`、`EAN-8`、`UPC-A`。公开入口与 CLI、字体、颜色、显隐和状态样式沿用 [CODE128 条形码流程](render-barcode.md)。三种格式的可执行工作区见 [商品编号样例](examples/retail-barcode-dsl/README.md)。

## 输入合同

```json
{
  "type": "barcode",
  "name": "商品码",
  "format": "EAN-13",
  "content": { "var": "productId" },
  "showText": true,
  "font": "res:font-hei-regular",
  "fontSize": 3,
  "place": {
    "left": 5,
    "top": 5,
    "width": { "fixed": 55 },
    "height": { "fixed": 30 }
  }
}
```

`format` 必须为固定格式名称，不能绑定变量。`content` 接受固定文本、文本字段或文本参数/派生变量；必须是包含最后一位校验位的完整 ASCII 数字字符串，不转数值、不修剪、不补校验位、不替换错误校验位。前导零属于原始编号，必须保留。

| 格式 | 完整长度 | 示例 | 码区模块数 | 左/右必要留白 |
|---|---|---|---|---|
| EAN-13 | 13 位 | `0012345678905` | 95 | 11 / 7 模块 |
| EAN-8 | 8 位 | `01234565` | 67 | 7 / 7 模块 |
| UPC-A | 12 位 | `012345678905` | 95 | 9 / 9 模块 |

引擎先校验长度、数字字符与校验位，再调用编码器，避免编码库自动补位。校验时从完整字符串最右侧起依次乘 1、3、1、3……，总和须为 10 的倍数。算法来源见 [GS1 校验位说明](https://www.gs1.org/services/how-calculate-check-digit-manually)，留白取自 [GS1 General Specifications 21.0.1，第 5.2.3.4 节](https://ref.gs1.org/standards/genspecs/21.0.1/)。

本票验证编号的语法和校验位，不查询编号是否已分配给某个商品。UPC-E、EAN 附加码和其他格式不开放。

## 出图与摘要

最窄模块至少 2 px，模块和条空宽度为整数像素。含左右必要留白的整体居中，因此 EAN-13 的条区相对背景中心略偏右；剩余像素再均分到两侧，不足一个像素的差额放在右侧。

其余尺寸和文字规则继承票据 02：确定宽高，上下各 1 模块保护间隔，条高至少 5 mm；下方文字单独占位，使用指定资源字体和缺字替代，与码图保护区至少间隔 1 mm，不压缩或自动缩字。完整原文整行居中显示，不采用商品包装常见的分组数字排版。条高与模块下限是本期产品规则，独立解码通过不代表已经取得 GS1 包装印刷质量认证。

`barcode` 布局摘要仍包含 `format`、`modules`、`moduleSizePx`、`drawn`、`symbol`、可选 `label`。EAN/UPC 的 `quietZoneModules` 和 `quietZoneMm` 用 `{ "left": 数值, "right": 数值 }` 分别记录两侧必要留白；实际留白可能因居中余量更大。CODE128 的这两个字段保留原标量形状，已有图片及摘要保持不变。TypeScript 调用方可按 `format` 缩窄 `BarcodeSummary` 类型。

## 失败处理

- 长度、字符、空值问题使用 `barcode.contentInvalid`；全角数字、空格、换行都拒绝。
- 新增 `barcode.checksumInvalid`，表示长度和数字字符正确，但校验位不符。
- 颜色和空间不足沿用 `barcode.colorsInvalid`、`barcode.sizeInvalid`；错误变量类型、字体缺失等沿用既有问题码。

严重问题定位到实际元素路径，包括循环序号。正式出图不交付图片；可展开的草稿只标问题框，不画该实例的条码或下方文字，其他合法实例仍可显示。两种模式的问题清单一致。

## 独立解码与复现

复用已锁定的 bwip-js 4.11.4 与 zxing-wasm 3.1.5 reader，没有新增依赖。编码和解码分别由独立实现负责；ZXing 直接读取最终 PNG/JPEG，WASM 从本地安装包加载。

UPC-A 与首位为零的 EAN-13 具有等价符号，不能仅凭图片推断调用方使用了哪一种编号表示。已实测锁定的 ZXing：限定 `UPCA` 时，报告格式 `UPCA`，但内容及原始字节为 `0 + 原始12位编号`；同时开放 EAN13/UPCA 时可能报告 `EAN13`。因此验收逐图限定目标格式、核对格式和全部字节：EAN 直接等于输入；UPC-A 只接受上述确切的 13 位表示。没有通用去零、转数值或接受任意格式别名。模板、布局摘要和下方文字始终保持用户指定的格式和原始编号。

```powershell
npm run typecheck
npm run build
$env:CI='1'; npm test
node scripts/accept-retail-barcodes.mjs out/stage2/retail-windows
docker run --rm -v "${PWD}:/work" -w /work node:22-alpine node scripts/accept-retail-barcodes.mjs out/stage2/retail-linux
```

2026-10-12：类型检查、构建通过；22 个文件、469 项测试通过，含本票新增 42 项。入口测试覆盖三格式的 48 种编号/文字开关/DPI/格式组合、绑定/状态/颜色/90°旋转、精确 2 px 与两侧留白、输入与校验位失败、循环定位、CLI 成果清理及三张 golden。

Windows Node v24.12.0 与 Linux Node v22.23.3 各 24 份图片独立解码通过，图片和布局 SHA-256 及完整解码结果一致，证据为输出目录中的 `hashes.json`、`decoding.json`、`environment.json`。CODE128 原有 8 份成品与摘要哈希未变，M402 的 11 份 JSON 未修改。本次共用构建、锁定依赖及字体；全新安装验收仍在票据 13。
