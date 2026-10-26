# 模板设计评估集：票据索引

本页只维护索引：标题、直接阻塞与验收映射。状态以各票据的 `**Status:**` 行为准，验收记录写在各票据的 `## Answer`。

父规格：[模板设计评估集](spec.md)。材料与用法见 [scripts/agent-eval/template-design/](../../scripts/agent-eval/template-design/README.md)。

| 票据 | 完整行为 | 直接阻塞 | 验收 |
|---|---|---|---|
| 01 | [评估命令能换配置跑，模板场景可逐例组资源、按数据驱动的压测与版面检查评分](issues/01-per-case-resources-and-data-driven-scoring.md) | 无 | A1、A3、A4 |
| 02 | [12 个用例有完整材料、领域约定与用例文档，经引擎校验](issues/02-cases-domains-and-docs.md) | 01 | A2、A4 |
| 03 | [首轮真实模型基线跑完，逐项复核检查，通过线定稿](issues/03-baseline-and-pass-lines.md) | 01、02 | A5 |
| 04 | [01、11、12 在现行材料下各重跑一次，确认基线后的修改](issues/04-confirm-reruns-on-final-materials.md) | 03 | A5 |
