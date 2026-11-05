# 115 参考图模板与正式出图

2026-11-04，M388。用户在本机模块验收后要求继续下一步，接续当前已展示的四个模板与既定 65 项范围；不新增解释、样式或模型提取。状态与完整验收记录见 [票据 09](../../.scratch/dataset-import-app/issues/09-reference-delivery.md)。

## 入口与文件

- [65 项正式批次](http://127.0.0.1:18080/console/#/batches/191092bf-735b-459f-b122-26bd1f99327b)：点击项看图，支持“下载图片”和“下载整批图片（zip）”。
- [主模板修订](http://127.0.0.1:18080/console/#/templates/wuxi-production-sign/publish)：主模板及三个关联模板均为修订 1。
- [模板制作](http://127.0.0.1:18080/console/#/templates/wuxi-production-sign/design)：继续修改时从当前修订创建工作副本，选 `115-up-display-review` 或 `115-down-display-review` 为样例数据。发布修订后工作副本按应用合同删除，并非模板丢失。

本机成果目录：`F:/GenCode/render-weave-runtime-31575c7/out/reference-delivery/`。

| 文件 | 用途 |
|---|---|
| `115-reference-revision1-delivery.zip` | 65 张按方向、站序、站名及尺寸命名的原始 PNG，加制作清单、排除清单和说明 |
| `115-reference-revision1-images.zip` | 从页面实际下载的官方纯图片包；0001–0065 对应批次项序号 |
| `制作清单.csv` | 站点、尺寸、来源单元格、原批注和每张图的 SHA-256 |
| `未生成项.csv` | 两个没有尺寸的终点及排除理由 |
| `delivered/` | 逐项图片、布局、问题清单、出图记录与独立核对回执 |

图片清单包 SHA-256：`ffec79fa3fc793e31b179cc3d21de8e6bdc32669035e6e5cb2d503b5e62bae63`。包里的 PNG 保持服务产物原字节；不包含字体及离线重放依赖。需要完整重放材料时使用应用的出图记录导出能力。

## 继续修改

四个模板的依赖顺序为 `wuxi-115-connection-mark` → `wuxi-115-transfer-marks` → `wuxi-115-stop-column` → `wuxi-production-sign`。后续修改先在工作副本预览、核对，再从被调用的模板向主模板发布；只改一份时只发布该份。旧正式模板 `production-115` 与历史交付保留。

已提交批次固定当时的数据、模板及资源，之后编辑不改变本批图片。新的样式需求应发布新修订并建立新批次；本轮重试必须使用相同幂等键及相同请求，不能重复建单。

尺寸沿用既定清单的 cm→mm 换算与 96 dpi，不填补缺失尺寸，也不从批注推断未明确的安装或材质。实际图标形状的像素还原评分未做；本轮不涉及实物印制。人工业务审核工时、实际扣费未知。运行与重启见 [本机说明](dataset-import-rollout.md)，生产托管仍有原有验收门槛。
