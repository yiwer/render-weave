# 二维码：文本绑定、像素模块与问题诊断

第二阶段票据 01 已实现 `qrcode` 元素，通过原有 `render` 入口与 CLI 输出 PNG/JPEG。独立样例见 [查询码工作区](examples/qrcode-dsl/README.md)，原 M402 的 11 份 JSON 保持不变。

## DSL

```json
{
  "type": "qrcode",
  "name": "查询码",
  "content": { "var": "queryUrl" },
  "errorCorrectionLevel": "M",
  "foreground": "#000000",
  "background": "#FFFFFF",
  "place": {
    "left": 5,
    "top": 5,
    "width": { "fixed": 50 },
    "height": { "fixed": 50 }
  }
}
```

- `content` 必填，为固定文本或 `{ "var": "路径" }`。绑定只接受文本类型，支持数据字段、文本参数与文本派生变量；数值不会自动转成编号，前导零原样保留。
- `errorCorrectionLevel` 为 `L`、`M`、`Q`、`H`，缺省 `M`。不绑定变量，可在状态样式中选择固定值。
- `foreground`、`background` 缺省黑、白，可绑定颜色变量；均须不透明且不同色。
- 位置、显隐、旋转、整体透明度和状态样式沿用共有规则。隐藏元素仍做静态检查，实际不编码、不报告空内容或容量问题。
- 要求布局能给出确定宽高：固定或填满均可，网格中省略宽高默认为填满；不支持自身 `hug`，自由/堆叠省略尺寸同样视为随内容并报告问题。不能用最小宽高绕过这一限制。

内容按 UTF-8 字节模式编码，支持中文、数字、URL 和 emoji；URL 只作为文字，不访问网络。版本及掩码由编码器确定；本期不做数字/汉字模式优化、不开放版本、掩码或留白开关。超过 2,953 字节提前拒绝，具体纠错等级的容量不足由编码器判断。空文本和孤立 UTF-16 代理项拒绝，空格及合法文本不修剪、不改写。

## 排布与摘要

模块保持正方形，四边各留 4 模块空白。布局在最终 DPI 下向元素框内侧取整数像素边界，选择放得下的最大整数模块边长，再把包含留白的正方形居中；奇数像素的余量允许两侧相差 1 px。每模块至少 2 px，否则报告严重问题。这是产品尺寸下限，实际可扫码还需独立解码验证。

绘制只消费布局记录，CanvasKit 关闭码区抗锯齿并逐模块填色，不经过图片缩放或插值。二维码之外的绘制仍使用原有抗锯齿规则。

布局节点的 `qrcode` 摘要包括：

| 字段 | 含义 |
|---|---|
| `format` | 固定 `qr` |
| `errorCorrectionLevel` | 实际纠错等级 |
| `modules` | 每边的码区模块数，不含留白 |
| `moduleSizePx` | 每个模块的整数像素边长 |
| `quietZoneModules` / `quietZoneMm` | 单侧留白，模块数固定为 4 |
| `drawn` | 含必要留白的正方形位置与尺寸，毫米 |
| `symbol` | 仅码区的位置与尺寸，毫米 |

与现有摘要一致，坐标相对画板且未计元素或祖先旋转；毫米摘要按现有精度舍入，绘制使用原始值。非正方形元素框不会拉伸码图。合格码图有此摘要；无法编码或尺寸/颜色不合法时保留元素框，不产生码图摘要或绘制指令。

## 失败处理

| 问题码 | 原因 |
|---|---|
| `qrcode.contentInvalid` | 空内容、绑定缺值或无效 Unicode |
| `qrcode.capacityExceeded` | 超过字节上限或该纠错等级可容纳的容量 |
| `qrcode.colorsInvalid` | 前景/背景透明或相同 |
| `qrcode.sizeInvalid` | 随内容尺寸、零尺寸或容纳不了至少 2 px 的模块与留白 |

全部为严重问题，定位包含循环序号的元素路径。正式出图不交付图片；可展开的草稿只画问题框，不生成占位二维码。诊断与正式一致。错误变量类型、未知变量、非法 DSL 结构仍使用既有模板问题码；模板不能解析时两种模式都不出图。

可扫码验收覆盖未遮挡、未裁剪、不透明的黑白码和深蓝/浅黄色样例，以及 90°旋转。共同支持的透明度、任意旋转、裁剪和后画元素仍可能破坏码图；不保证任意组合、低对比配色或实际印刷条件都可扫码。

## 依赖与验证

运行依赖锁定 `qrcode 1.5.4`（MIT），只调用同步符号生成；选择依据是公开矩阵接口、字节模式及四种纠错等级，保留现有 CanvasKit 合成。测试依赖 `jsqr 1.4.0`（Apache-2.0）读取最终图片像素，独立验证编码结果；类型声明 `@types/qrcode 1.5.6` 仅用于开发。许可证也已核对安装包。

来源：[node-qrcode 官方说明与许可证](https://github.com/soldair/node-qrcode)、[jsQR 官方说明与许可证](https://github.com/cozmo/jsQR)、[DENSO WAVE 四模块留白说明](https://www.qrcode.com/en/howto/code.html)。

```powershell
npm run typecheck
npm run build
$env:CI='1'; npm test
node scripts/accept-qrcode.mjs out/stage2/qr-windows
docker run --rm -v "${PWD}:/work" -w /work node:22-alpine node scripts/accept-qrcode.mjs out/stage2/qr-linux
```

入口测试覆盖 48 种内容/纠错/DPI/格式组合、绑定与状态样式、2 px 边界、失败模式、循环定位、重复确定性及 CLI 成果清理；新增一张小型 golden 固定画面。平台脚本独立解码 16 份查询码图片，并输出图片及布局摘要 SHA-256，平台环境另存。平台脚本使用同一构建和锁定依赖验证运行一致性；全新环境安装仍属阶段票据 13。
