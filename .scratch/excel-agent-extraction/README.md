# Excel 制作表处理票据

规格见 [spec.md](spec.md)，阶段划分见[流程设计](../../docs/excel-agent-workflow.md)。

| 票据 | 直接阻塞 | 验收映射 |
|---|---|---|
| [01：验证工作簿读取、隔离转换和独立核对](issues/01-validate-data-processing-prototype.md) | 无 | P01–P03；A01/A02/A03/A04/A06/A08/A09 的机制子集 |
| [02：按工作空间 staticSchema 接入 Claude 并运行一轮测试](issues/02-connect-schema-driven-agent.md) | 01 | P04；通用字段映射、真实模型反馈重提与非公交样本 |
| [03：将 Excel 候选接入审核、修正重放与完整应用](issues/03-review-correct-apply.md) | 02 | P05；正式审核、来源匹配修正、完整提交与嵌套定义实测 |
