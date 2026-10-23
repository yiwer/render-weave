# 图片资源夹具

由 `scripts/make-image-fixtures.ts` 生成（`npx tsx scripts/make-image-fixtures.ts`），结果提交在本目录，平时不需要重跑。资源 ID 登记在上一级的 `resources.json`。

| 文件 | 资源 ID | 来源 |
|---|---|---|
| `m402/route-no-m402.png` | `route-no-m402` | 从 [M402 设计稿](../../../docs/examples/materials/m402-route-sign.jpg)裁出线路号"M402"（x 205–670、y 15–152 像素，120 DPI），按已知的橙色底色 `#FF8000` 反解透明度，得到透明底的图片 |
| `m402/landmark-1.png` 至 `landmark-4.png` | `landmark-1` 至 `landmark-4` | 用思源黑体 Medium 的带圈数字 ①–④ 绘制，深灰 `#222222`，按墨迹居中，96 × 96 像素 |
| `m402/icon-metro.png` | `icon-metro` | 示意图标：绿底圆形加白色"M"（思源黑体 Heavy），不是官方标志 |
| `m402/icon-hospital.png` | `icon-hospital` | 示意图标：红底圆形加白色十字 |
| `test/quadrants.png`、`.jpg`、`.webp` | `test-quadrants-png`、`-jpg`、`-webp` | 200 × 100 像素四色测试图：左上红、右上绿、左下蓝、右下黄，外加 10 像素黑边，用于检查三种格式与三种适配方式（铺满裁剪会裁掉两侧黑边） |
| `test/vector.svg` | `test-vector-svg` | 手写的 80 × 40 矢量测试图，含路径、渐变、内部 CSS、圆角裁剪与细线；用于 SVG 三种适配、高 DPI 和跨平台验证，不由位图生成脚本生成 |

设计稿中地标随站点状态变色（已过站灰、本站红），夹具只提供深灰一种；M402 模板按状态样式调整透明度（见 DSL 草稿 `template-stop.json`）。
