# 08：按用户批准的 115 路样张口径应用并正式交付

**What to build:** 将用户“继续下一步，批准”落实到审核记录，应用两份完整候选，以已展示口径生成 65 张正式图片并核对自足重放。

**Blocked by:** 07

**Status:** resolved

**Trace:** 用户明确批准；P07 实表正式出图。

- [x] 记录批准原话与范围，经公开审核/应用入口提交完整候选。
- [x] 按厘米、既有版式与 65 项范围准备正式计划；两个缺尺寸终点保留数据、显式跳过制作。
- [x] 正式图片不带待核准标记；逐项核对内容、尺寸、批注来源并验证交付记录重放。
- [x] 提供正式图片索引与记录，保留前轮草稿；人工工时与实际扣费仍记未知。

**测试接缝：** changeReview / applyAgentRound、正式 prepare-output / deliver-output CLI、readOutputRecord / replayOutputRecord，以及原件独立真值。

## Answer

2026-11-03 完成。工作目录 `F:\GenCode\render-weave-excel-prototype`，本轮成果 `out/excel-p07/930898314428416/final-01/`（以下称成果目录）。

- `node <成果目录>/approve-prepare.mjs`：公开入口批准并应用 2 份候选；正式 CLI 准备退出 0，7 组、65 项、159 条组内排除，4102 ms。脚本尾部最初误把 CLI 的数值 items 当数组，准备成功后断言报错；已修正脚本，由后续交付脚本同时复查 CLI 摘要与 prepared.json，未重复批准或应用、未覆盖准备目录。
- `node <成果目录>/deliver.mjs`：正式 CLI 退出 0，state=delivered；65 delivered、0 previewed / failed / notRun / severe / hints，6199 ms。
- `node <成果目录>/verify.mjs`：65 张、2080 个站名与原件独立真值完全一致；本站/下一站/终点/首末班/编码、制作尺寸说明和 PNG 像素尺寸通过；65 个原始制作项覆盖唯一且完整，两个缺尺寸终点明确跳过。完整候选与原件独立真值一致，10 批注保留，原件哈希不变。
- 同一验证脚本逐项读取自足记录并重放全部 65 项，图片字节、布局摘要、问题清单全部一致；内容核对与全量重放合计 50680 ms。审核 approved，应用回执 `889abb6c-8a11-48af-a3fe-0585431f30df`。
- `node <成果目录>/gallery.mjs` 与 `node <成果目录>/browser.mjs`：Chrome headless 解码 65 图片、显示 10 批注块，尺寸和站名筛选通过，缺尺寸终点批注可见，页面错误 0；查看正式代表图和总览截图，试制标记已去除。
- PowerShell `Compress-Archive` 打包图片与清单；逐项解压读取并比对 SHA-256，69 文件 / 65 图片全部一致，ZIP 9864149 字节。成果入口 `index.html` 和 `115-production-images.zip`，记录分层见[说明](../../../docs/agent-eval/excel-production-delivery-115.md)。

没有修改引擎代码；采用真实正式链路与全量重放验证本轮，不重复运行前轮单元测试。人工业务审核工时、实际扣费未知；本轮模型调用 0。生产工作簿入口、隔离及完整旧模块替代仍未完成，不将本票标成整个 P07 成本验收结束。
