# 09：发布参考图模板并完成 65 项出图

**What to build:** 依照用户在明确下一步后的“继续下一步”，发布当前四个参考图模板，沿用已列明的 65 项范围生成应用内正式出图记录、可下载图片及逐项核对证据。

**Blocked by:** 08

**Status:** resolved

**Trace:** 用户在票据 08 完成后要求继续下一步；M388。

- [x] 发布前确认数据及四个工作副本与已展示候选一致，保留原正式模板。
- [x] 依赖顺序发布四个模板，记录修订、哈希及发布页结果。
- [x] 幂等提交 65 项正式批次，全部成功，逐项下载真实服务产物。
- [x] 独立核对站名、状态、时刻、编码、尺寸及换乘标记；保留两个无尺寸终点的排除原因。
- [x] 提供应用入口、本机图片包及可接续记录；不把此操作记成实物印制或像素还原评分。

**测试接缝：** 固定运行服务的公开 API、真实浏览器、正式出图文件与原件独立真值；不新增模型提取。

## Answer

2026-11-04 完成（America/Los_Angeles；UTC 日志为 11-05）。沿用固定运行提交 `31575c7`，没有修改或重建服务源码。本轮“继续下一步”发生在上一轮明确“确认参考图样式后发布模板、正式出图”之后，作为当前已展示候选的发布与既定清单出图授权留证；没有追加新的业务解释或样式，没有把指令换算为人工审核耗时或逐像素评分。

### 执行与证据

本机脚本及完整成果位于 `F:/GenCode/render-weave-runtime-31575c7/out/reference-delivery/`。

1. `node out/reference-delivery/preflight.mjs`：API 与 worker 构建相同，模板审批策略没有启用额外审批；四份工作副本 SHA-256 等于票据 08 的已展示版本。固定现有正式模板、数据及 65 项请求；保留两项无尺寸终点的排除理由。原 plan.json 保持历史候选状态，新操作授权单独记入 preflight.json，没有修改历史批准字段。
2. `node out/reference-delivery/publish.mjs`：发布前两份线上数据与原提取候选逐字段相等；重算原 Excel SHA-256 与独立真值来源一致。按 connection-mark → transfer-marks → stop-column → production-sign 顺序，在真实浏览器发布四个模板，均为修订 1；每项发布预检 problems=[]，网页 pageErrors=[]，每项均留发布前后截图。当前内容哈希及修订见 published.json；原正式模板不变。
3. `node out/reference-delivery/deliver.mjs`：以固定幂等键 `reference-115-revision1-65-20261104` 提交，批次 `191092bf-735b-459f-b122-26bd1f99327b`，mode=final。结果 total=65、delivered=65、failed=0、notRun=0、severe=0、hints=0。没有把旧预览 PNG 改名充当正式成果。
4. `node out/reference-delivery/download.mjs`：通过服务逐项文件端点下载 65 张 PNG、布局、问题及出图记录，共 260 份文件。`node out/reference-delivery/verify-files.mjs` 核对全部本机文件 SHA-256；195 份图片/布局/问题文件的哈希、大小与服务出图记录匹配，65 张 PNG 像素尺寸符合毫米与 96 dpi 换算。数据及原正式模板仍未改变。
5. `node out/reference-delivery/verify-content.mjs delivered` 与 `python out/reference-delivery/verify-markers.py delivered`：复用原独立 OOXML 真值和独立核对逻辑，只改输入产物目录，65/65 通过；2080 次站名展示、本站/下一站颜色、首末班、站码、尺寸及溢出核对通过。715 个换乘标记通过（metro-1 65、metro-3 455、metro-4 130、railway 65）；圆标检查含真实图片区域主色，设施检查仅证明资源来源，未宣称图标形状与原图一致。上行第 13 站 PNG 已实际查看。
6. `node out/reference-delivery/browser.mjs`：批次页“已完成”及画面留截图；点击“下载图片”，下载内容与逐项文件一致；点击“下载整批图片（zip）”，获得 65 张图片的官方压缩包，pageErrors=[]。Python zipfile 做 CRC、项数及全部图片哈希核对通过。
7. 图片与清单包把官方 PNG 原字节按“批次序号／方向／站序／站名／尺寸”命名，加入制作清单.csv、未生成项.csv 和交付说明.md；共 68 项，CRC 全过。清单保留原批注、来源单元格和 PNG 哈希，不额外猜安装位置。包大小 13247971 字节，SHA-256 `ffec79fa3fc793e31b179cc3d21de8e6bdc32669035e6e5cb2d503b5e62bae63`。它是图片与清单包，不含离线重放所需字体。
8. `node out/rollout/status.mjs`：最后活动 Agent=0、渲染=0；构建一致。没有新增模型调用；没有运行不相关的全量测试。

### 成果与边界

- [应用批次](http://127.0.0.1:18080/console/#/batches/191092bf-735b-459f-b122-26bd1f99327b)、[模板修订](http://127.0.0.1:18080/console/#/templates/wuxi-production-sign/publish)。
- 本机图片清单包：`out/reference-delivery/115-reference-revision1-delivery.zip`；官方纯图片包：同目录 `115-reference-revision1-images.zip`。
- 可入库 [机器回执](../../../docs/agent-eval/reports/2026-11-04-reference-115-delivery.json) 汇总本轮证据；[使用说明](../../../docs/agent-eval/reference-115-delivery.md) 提供入口与继续改模板的方法。私有材料、登录资料、原件及全量图片不提交。
- 65 项范围仍为 450×208 mm 18 张、525×135 mm 44 张、480×135 mm 2 张、890×270 mm 1 张，96 dpi。下行终点“无锡汽车站”和上行终点“江南影视学院”因原件缺尺寸未生成各自本站制作项，站名与批注仍在数据中。
- 当前版本已完成应用内发布与正式出图，不等于实物印制、像素还原评分或生产托管验收。人工业务审核工时和实际扣费未知。
