# scripts/m190（已退役）

M190 的 Agent 运行方式验证脚本已在第三阶段票据 08 退役，由经产品路径运行的评估工具取代：

- **评估**：`npx tsx scripts/agent-eval/run.ts`，场景、通过线与报告见 [Agent 评估](../../docs/agent-eval.md)；
- **评分**：沿用这里的检查，在 `scripts/agent-eval/score.ts`；
- **场景资料**：项目说明、出图请求与 366 的人工转录，在 `scripts/agent-eval/scenarios/`。

验证当时的看图（vision）、工具闭环（loop）与一次性的 design、template 步骤，记录在 [Agent 运行方式验证](../../docs/agent-validation.md)。脚本原文见提交 `e09ca8d` 及更早的历史。
