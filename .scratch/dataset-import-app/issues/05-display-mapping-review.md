# 05：显示字段进入可重放的数据审核并接续参考图模板

**What to build:** 为工作空间定义的显示类别提供显式、可独立核对的映射，将同一原件的新字段与参考图模板组成可审阅成果。

**Blocked by:** 04

**Status:** resolved

**Trace:** 用户“继续下一步”；M373、M376。

- [x] 通用映射支持显式类别对照，未知值失败，保留原文、顺序、重复项与来源。
- [x] 审核展示映射规则；改变规则后不静默重放旧人工修改。
- [x] 同一原件按显示定义进入正式导入审核；独立核对 64 站、22 个换乘类别、10 条批注及 VML。
- [x] 参考图模板与新数据形成可查看样张、批量范围和审核依据；不把旧批准自动扩展到新增解释及样式。

**测试接缝：** 正式 importExcelRound、readReview、人工修正重放；应用真实模型任务和浏览器审核；模板公开渲染入口。

## Answer

2026-11-04 完成显示字段的正式审核接入与样张准备；未将本次技术验收登记为业务批准。现场见 [说明](../../../docs/agent-eval/dataset-display-115-review.md)，摘要见 [报告](../../../docs/agent-eval/reports/2026-11-04-display-review-115.json)。以下命令在 `F:/GenCode/render-weave-dataset-import-app` 执行，私有脚本与输入输出保留在 `out/display-115/`。

- `node out/display-115/upload.mjs`：浏览器上传同一原件，按 `production-direction-view@1` 新建真实任务。1 次模型运行、16 轮、259456 ms、2 次转换；首次 timeout，第二次通过，原始失败完整归档。
- `node out/display-115/verify.mjs`：独立 OOXML 真值核对 64 站全部原字段、22 个新增类别、10 条批注、10 个 VML 锚点，64 份来源对照一致。初版验收脚本未考虑原文方向标签内部空格，修正验收脚本后通过，产品数据和原文未修改。
- `node out/display-115/review-browser.mjs`：应用真实页面核对 64 站与 64 份显示映射，10 条批注、VML 展示，1600/800 宽度无溢出、无脚本异常；任务保持 needsReview，未保存新数据。
- `node out/display-115/render.mjs`：用本轮候选和前轮四个模板候选重新出 65 张草稿，0 问题。`verify-content.mjs` 检查 2080 个站名、状态、时间、站码、尺寸；`python -X utf8 out/display-115/verify-markers.py` 检查 715 个站点标记，全部通过。
- `node out/display-115/gallery.mjs`、`gallery-browser.mjs`：总览 65 卡片、67 图片、10 批注，尺寸/站名筛选及窄屏通过。总览服务 `node out/display-115/serve.mjs` 只绑定 127.0.0.1:18115。
- `RW_BROWSER=<本机 Chrome> npx vitest run test/agent-excel-mapping.test.ts test/agent-excel.test.ts test/agent-excel-comments.test.ts service/test/agent-jobs.test.ts service/test/agent-jobs.browser.test.ts --maxWorkers=2`：5 文件、49 测试通过，26.62 秒。新增 7 项涵盖原文/重复/空白、未知类别、伪造结果与来源、非法/过深规则和修正重放冲突；使用物料类别夹具证明无线路特判。
- `npm run typecheck`、`npm run typecheck:service`、`npm run build`、`npm --prefix service run build` 通过。`node scripts/scan-keys.mjs out/display-115 ...` 扫描 380 文件、命中 0；完整原件、凭据和图片未提交。

偏差与后续：沿用前轮留证的 450 mm 线路号修正，未再次调用模板模型；没有像素还原评分。近似图标、副名 5 mm、各尺寸版式以及新增映射已形成具体审核材料，等待用户确认后再应用新版数据与模板、正式交付 65 项。人工业务审核工时与实际扣费未知，生产隔离门槛不变。
