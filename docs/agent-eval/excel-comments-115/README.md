# 批注接入的汇总证据

解释见[实测报告](../excel-agent-comments.md)，验收状态与命令见[票据 06](../../../.scratch/excel-agent-extraction/issues/06-preserve-workbook-comments.md)。

- `summary.json`：同原件身份、模型用量、检查结果、最终代码与本地完整产物哈希。模型基线为 `ffa81cb` 加本轮工作区实现；模型运行后补显式 Visible=false 处理，最终读取视图与模型输入完全一致。
- `tests.json`：Excel / 出图 / 审核及初版批注组 61 项通过。
- `comment-tests-final.json`：最终批注组 23 项通过，含新增可见性用例。两批共 62 个不同用例。
- `browser-check.json`、`vml-comparison.json`：实际浏览器核对和独立锚点比对。

完整运行保存在 `out/excel-p07/930898314428416/comments-01/`。此目录是汇总子集，不是提取包，也不能拿它直接导入、审批或出图。人工业务审核时间和实际扣费均未知。
