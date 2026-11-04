# 09：将 115 路示例图接入模板制作模块

**What to build:** 用用户提供的站牌示例驱动现有 Claude + OpenCode Go 模板制作入口，基于已批准 Excel staticSchema 生成动态模板，再验证 65 项制作范围。

**Blocked by:** 08

**Status:** resolved

**Trace:** 用户要求配合模板制作模块，提供 115 路上行第 13 站参考图。

- [x] 固定示例图、现有数据定义及候选，以真实模板制作入口运行，不改原件或已批准数据。
- [x] 生成基于 currentIndex 的动态模板，核对站名分栏、本站/下一站状态、时间、图例及换乘附注。
- [x] 对照参考样张，并覆盖原 65 项与四种尺寸，明确视觉差异与阻塞。
- [x] 归档模型运行、技术校验和可查看成果；不继承旧版式的批准到新模板。

**测试接缝：** agent run 模板辅助设计/修改；公开 render / readReview 与独立原件真值。

## Answer

2026-11-03 完成模板候选与联动预览，不代表新样式已批准或完整生产接入完成。工作目录 `F:\GenCode\render-weave-excel-prototype`，成果 `out/excel-p07/930898314428416/template-01/`（以下称成果目录）。

- 真实 `node dist/bin.js agent run --task template-design ...`：run-01，qualified、退出 0，Claude Code 2.1.296 + OpenCode Go / claude-haiku-5-5，666272 ms；执行器报告 61 turns、outputTokens 76317、thinkingTokens 45725、inputTokens 54、cacheReadTokens 2270014、cacheCreationTokens 143321。
- 真实 `agent run --task template-revision ...`：run-02，qualified、退出 0，821706 ms；执行器报告 81 turns（原样保存）、outputTokens 103831、thinkingTokens 72558、inputTokens 56、cacheReadTokens 3102312、cacheCreationTokens 202343。两个轮次均保留未校准视觉比较结论，不将 qualified 当作参考还原通过。
- `node <成果目录>/setup-view.mjs`：公开 publishStaticSchema 发布 3 份工作空间显示定义，checkDataset 验证 2 份投影；64 条原始记录移除新增字段后逐字段完全一致；22 个换乘类别有原文、路径和单元格来源。原始定义和数据不改。
- `node <成果目录>/render-candidates.mjs run-02 preview-03 --polish`：65 张、0 severe / hints。宿主只追加线路号右对齐这一处局部尺寸修正；原模型候选留在 preview-02 和 run-02，不覆盖。
- `node <成果目录>/verify-content.mjs preview-03`：65/65 通过，2080 个站名与独立原件真值一致（仅统一括号显示形态、忽略空白）；本站/下一站/其余状态色、起终点、下一站、HH:mm、站码、尺寸通过；全部图片的线路号与“路”字不相交。
- `python <成果目录>/verify-markers.py preview-03`：650 个地铁圆标的编号和 PNG 像素主色通过（1 号 65、3 号 455、4 号 130），65 个火车站标记的资源来源通过，无额外站点设施图标，合计 715 项。这里只验证类别、颜色和来源，不认证矢量近似图标与原图形状一致。
- `node <成果目录>/gallery.mjs`、`browser.mjs`：Chrome headless 加载 65 卡片、67 图片、10 批注块；尺寸与站名筛选通过，待审身份可见，页面错误 0。查看第 13 站和四类尺寸代表图，450 mm 的线路号相交修正已生效。
- `node <成果目录>/summary.mjs`：原 PNG / Excel 哈希不变，原两份候选和 approved 状态不变；新模板轮次 inProgress、未应用；人工业务审核工时和实际扣费均未知。

偏差与下一步：图标近似、副名 5 mm、图例比例与不同长宽比的站名字距仍需视觉核准；新增 connections 显示投影目前为有来源记录的本地转换，尚未进入正式 Excel 导入/审核链路。因此本轮只交候选与联动预览，不将前轮批准套到新解释或新版式。没有修改通用引擎，不重复前轮引擎单元测试。操作与成果地图见[说明](../../../docs/agent-eval/excel-template-115.md)。
