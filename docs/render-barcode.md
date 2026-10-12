# CODE128：资产编号、下方文字与出图诊断

第二阶段票据 02 已实现 `barcode` 元素的 CODE128 格式，使用现有公开 `render` 入口及 CLI。独立工作区见 [资产编号样例](examples/barcode-dsl/README.md)。原 M402 的 11 份 JSON 不修改；EAN-13、EAN-8 和 UPC-A 留给票据 03。

## DSL

```json
{
  "type": "barcode",
  "name": "资产码",
  "format": "CODE128",
  "content": { "var": "assetId" },
  "foreground": "#000000",
  "background": "#FFFFFF",
  "showText": true,
  "font": "res:font-hei-regular",
  "fontSize": 3,
  "place": {
    "left": 5,
    "top": 5,
    "width": { "fixed": 110 },
    "height": { "fixed": 32 }
  }
}
```

- `format` 必须明确指定 `CODE128`，不能绑定变量。其他格式当前拒绝。
- `content` 必填，为固定文本或严格文本变量绑定，可取字段、参数、文本派生变量。接受 U+0020–U+007E 的可打印 ASCII，包括空格、大小写、数字和标点；拒绝空串、中文、换行、控制字符及自动数值转换。
- 前导零和首尾空格原样保留，不修剪、不格式化；`^FNC1`、`^123` 等也是普通文字，不解析为库指令。不生成 GS1-128 或开放 FNC 功能字符。
- 内容最多 500 字符，与锁定编码器的输入上限一致。这是本期产品边界，不是 CODE128 的通用标准容量；在最终尺寸下通常会更早触发空间不足。
- `foreground` / `background` 缺省黑白，可绑定颜色，必须不透明且不同。
- `showText` 缺省 `false`，可绑定布尔变量或由状态样式切换。开启时须提供 `font` 资源引用；字体不绑定变量，可通过状态样式换字体。`fontSize` 为毫米，缺省 3，须大于 0，也可绑定数值。关闭文字时不加载该字体。
- 位置、显隐、旋转、整体透明度及状态样式沿用共有规则。隐藏元素仍检查静态引用，实际不编码、不加载字体。尺寸必须为固定或填满；网格省略尺寸时填满，自由/堆叠省略时视为随内容并拒绝，最小尺寸不能绕过此限制。

## 模块、留白与文字空间

编码器只生成条空序列和校验符号；引擎按最终 DPI 在元素框内取整数像素边界。选择同时满足宽高的最大整数模块宽度，最窄模块至少 2 px；条空均为该宽度的整数倍，关闭抗锯齿逐条填色，不缩放图片。

左右各保留至少 10 模块空白，码区水平居中，奇数像素余量允许相差 1 px。上下各保留至少 1 模块保护间隔；条高至少 5 mm。这些尺寸检查是产品交付下限，不代替实际印刷或扫描等级认证。

下方文字显示原始内容，颜色与前景一致。它使用现有资源字体、逐字缺字替代及文字绘制流程：替代成功记提示，找不到字体或替代后仍缺字记严重问题。文字单独预留实测行框及外伸墨迹的空间，与上方码图保护区至少间隔 1 mm；不压缩、不自动缩字。文字宽度或剩余条高不够时应扩大元素或减小 `fontSize`。

布局节点的 `barcode` 摘要包含：

| 字段 | 含义 |
|---|---|
| `format` | 固定 `CODE128` |
| `modules` | 码区总模块数，包含起止与校验符号，不含留白 |
| `moduleSizePx` | 最窄模块的整数像素宽度 |
| `quietZoneModules` / `quietZoneMm` | 单侧必要水平留白，固定 10 模块；居中后的实际留白可能更大 |
| `drawn` | 完整背景框，含留白、保护间隔及可选下方文字 |
| `symbol` | 实际条区的位置、宽度及条高 |
| `label.box` / `label.text` | 开启文字时的独立区域及文字摘要；片段保留原字体、实际替代字体和字号 |

位置和尺寸以毫米记录，按现有精度舍入，相对画板且未计元素或祖先旋转；绘制使用未舍入值。

## 失败行为

| 问题码 | 原因 |
|---|---|
| `barcode.contentInvalid` | 空内容、绑定缺值或非可打印 ASCII |
| `barcode.capacityExceeded` | 内容超过 500 字符 |
| `barcode.colorsInvalid` | 同色或透明前景/背景 |
| `barcode.sizeInvalid` | 随内容或零尺寸；模块、留白、条高或下方文字放不下 |

以上为严重问题并附元素实例路径。错误变量类型和非法 DSL 使用已有模板问题码；字体问题使用现有资源/缺字问题码。正式出图不交付图片；可展开的草稿只标错误位置，不绘制该实例的条码或下方文字。草稿与正式诊断一致；其他合法实例继续显示。结构错误导致模板不可展开时，两种模式都不出图。

独立解码已覆盖未遮挡、未裁剪、不透明的黑白及深蓝/浅黄样例，以及 90°旋转。任意低对比配色、透明度、裁剪、遮挡或任意角度旋转仍可能破坏可读性；合格尺寸不等于所有印刷与扫描条件都能读到。

## 依赖与复现

运行依赖锁定 `bwip-js 4.11.4`（MIT，BWIPP 编码核心同为 MIT）。选择其同步 `raw` 接口，直接获得条空宽度；不使用其图片或内置文字绘制。包中其他组件的许可证随依赖保留，内置字体不参与本引擎出图。[官方原始数据接口说明](https://github.com/metafloor/bwip-js/wiki/Notes-on-the-Raw-BWIPP-Data)、[项目与许可证](https://github.com/metafloor/bwip-js)。

开发依赖锁定 `zxing-wasm 3.1.5`，测试只用 reader：封装层 MIT，ZXing-C++ 核心 Apache-2.0；发布包其他来源许可证见其[官方许可证清单](https://github.com/Sec-ant/zxing-wasm#licenses)。本地加载锁定包内的 WASM，不访问 CDN。ZXing 从最终 PNG/JPEG 文件独立解码，不消费编码器内部序列。

```powershell
npm run typecheck
npm run build
$env:CI='1'; npm test
node scripts/accept-barcode.mjs out/stage2/code128-windows
docker run --rm -v F:/GenCode/RenderWeave:/work -w /work node:22-alpine node scripts/accept-barcode.mjs out/stage2/code128-linux
```

2026-10-12：类型检查与构建通过，21 个文件、427 项测试通过，其中条形码新增 34 项。入口测试覆盖 24 种内容/文字开关/DPI/格式组合，另验证全部 95 个可打印 ASCII、绑定、循环、90°旋转、2 px 边界、字体替代及失败模式。新增一张带下方文字的 golden；原 M402 和二维码回归通过。

Windows Node v24.12.0 与 Linux Node v22.23.3 各 8 份验收图片独立解码成功，图片及布局 SHA-256 一致，证据存于上述输出目录。此次跨平台共用构建、锁定依赖及字体；全新安装验收仍属票据 13。
