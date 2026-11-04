# Excel 制作表处理票据

规格见 [spec.md](spec.md)，阶段划分见[流程设计](../../docs/excel-agent-workflow.md)。

| 票据 | 直接阻塞 | 验收映射 |
|---|---|---|
| [01：验证工作簿读取、隔离转换和独立核对](issues/01-validate-data-processing-prototype.md) | 无 | P01–P03；A01/A02/A03/A04/A06/A08/A09 的机制子集 |
| [02：按工作空间 staticSchema 接入 Claude 并运行一轮测试](issues/02-connect-schema-driven-agent.md) | 01 | P04；通用字段映射、真实模型反馈重提与非公交样本 |
| [03：将 Excel 候选接入审核、修正重放与完整应用](issues/03-review-correct-apply.md) | 02 | P05；正式审核、来源匹配修正、完整提交与嵌套定义实测 |
| [04：从已应用数据集准备通用渲染项并交付](issues/04-prepare-and-deliver-output.md) | 03 | P06；模板参数、列表位置、完整范围、固定依赖与交付重放 |
| [05：用用户提供的实际制作表运行一次 CodingAgent](issues/05-try-user-production-workbook.md) | 04 | P07 首次实表探索；独立正文比对、批注缺口与完整失败证据 |
| [06：让业务批注进入 Excel 提取与独立审核](issues/06-preserve-workbook-comments.md) | 05 | P07 / A01 / A04；批注来源、VML 判别及同原件复跑 |
| [07：从待审实表生成可核对的制作计划与试制样张](issues/07-preview-production-plan.md) | 06 | P07 出图前核对；多尺寸清单、完整站序草稿与待确认项 |
| [08：按用户批准的 115 路样张口径应用并正式交付](issues/08-approved-production-delivery.md) | 07 | P07 实表正式交付；用户批准、完整应用、固定计划与全量重放 |
| [09：将 115 路示例图接入模板制作模块](issues/09-template-module-115.md) | 08 | 模板辅助设计/修改；显示定义、原图对照、四尺寸联动预览 |
