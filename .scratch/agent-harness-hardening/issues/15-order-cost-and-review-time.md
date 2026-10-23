# 15: 按完整订单核算尝试成本与人工投入

**What to build:** 将任务轮次、全部尝试、审核修正和正式交付关联成可核对的订单报告，并提供不泄露凭据与业务素材的分享摘要。

**Blocked by:** 05、07、09

**Status:** resolved

**Trace:** [父规格](../spec.md) D14、D16；US46、US55–57、US62–63；A13 的订单汇总子项；A17 的原始成果/人工补救记录能力；A20 的真人走查时间记录能力。

它交付后续试验与真人走查所需的记录能力，不代替留出执行或最终走查。

- [x] 报告关联订单、任务轮次、尝试、候选、检查报告、审核和提交/出图结果；接续、失败重试、恢复和重复查询不会将同一尝试或同一提交重复计入。
- [x] 保留 Agent 原始成果与人工修正后成果的独立结论及关联，人工补救不能改写原始质量或被算为 Agent 首次成功；审核、修正、返工分钟分别记录，未记录时间明确未知。
- [x] 成本纳入该订单全部成功、失败、中断和重试尝试；已知用量、未知尝试数、总墙钟、各轮耗时求和分别显示，沿原始尝试能复核汇总，thinking 不重复计数。
- [x] 质量与交付口径分开：invalid 可排除于模型有效观测分母，但继续出现在交付可用性与成本记录中；报告明确计划、尝试和订单三个计数层次。
- [x] 预先说明订单统计范围；单位成功订单成本以该范围内成功应用并完成所需正式出图的订单计分母，分子包括范围内所有订单（含最终未成功订单）的尝试与人工投入。没有成功订单时标为未定义，不能借用技术合格数量；单笔订单成本另列。
- [x] 仅在完整用量与提供方计价版本可获得时估算金额并注明口径；否则展示原始用量及未知部分，不猜测订阅金额或远端停止计费时点。
- [x] 可分享摘要保留必要关联标识、身份和诊断，去除凭据、原图敏感内容及不必要本机路径；完整业务材料留在访问受控的轮次记录中，分享摘要不能被当作完整复现包。
- [x] 通过公开流程构造成功交付、审核拒绝后修正、恢复后成功、无成功订单、缺用量和缺人工时间的对照，确认报告与实际状态一致；后续真实走查只填充这些既有能力，不承担补实现。
- [x] 同步本票涉及的记录、报告、操作说明和兼容规则；旧订单缺失字段保持未知，不补造历史人工时间或用量，所需合同变化随本票处理。

**测试接缝：** 公开 Agent 运行/接续、审核、应用、正式渲染及报告/分享入口；使用受控执行器与公开人工时间记录操作观察成果，不断言内部聚合容器。

## Answer

完成日期：2026-10-23。主实现 `49caf85`，合入集成 `29cb9c6` 为 `6e2de9a`；独立规格审查修复 `44d7287`，整轮耗时/分享身份修复 `4ccd50f`，最终并行夹具同步 `346eba7`。

公开入口 `agent order-init/order-record/order-report` 及 `--share` 已实现，程序入口从 `src/index.ts` 导出。`src/agent/orders.ts` 关联预登记范围、四类任务计划、原件与兼容视图、接续检查点、原始检查、有效候选、审核、应用和正式输出；共用 `attempt-records.ts` / `round-metrics.ts` / `execution-error.ts` 保持评估与订单计量口径一致，不从产品代码反向导入评估脚本。

已验证的行为：全部失败、成功、中断、重试及派发前失败保留；原件与兼容视图不重复；范围外前序或旧历史明确不完整；原始业务结论和人工修正后结论独立，旧审核不为后来修改背书。审核、修正、返工分别记录，事件幂等并绑定范围及成果；未记录不补零。完整轮次耗时和并行区间并集分开，thinking 不重复。成功订单分母只认全部计划应用及所需正式出图，成本分子包含失败订单，零成功未定义。只有固定提供方版本/实际服务模型/完整用量都匹配时才按输入、输出、缓存读写四类费率估价。分享按白名单保留身份、数值、停止枚举和分类诊断，不复制路径、素材、自由文本或凭据。

公共红绿重点：正式交付同名数据集已换内容被拒绝；已登记成品不因后来工作区变化失效；人工事件篡改及复制到另一范围被拒绝；多个计划不能用单计划通过代替；范围外前序即使当前成功交付且人工时间填齐，人工单位成本仍不完整；派发前额度错误仍计入invalid和未知成本；真实MCP保存后强退、接续并正式交付；并行实际执行揭示并修复了执行器耗时与整轮起止混用。

验证命令与结果：

- `npm run typecheck`、`npm run build`、`git diff --check`：通过。
- Windows：`npx vitest run test/agent-orders.test.ts test/agent-eval.test.ts test/agent-eval-identity.test.ts test/agent-eval-attempts.test.ts test/agent-eval-attempts-cli.test.ts test/cli.test.ts --maxWorkers=1`：6文件69项通过，195.15秒（当时订单16项）。
- 最后整轮计时/分享修复后，Windows：`npx vitest run test/agent-orders.test.ts --maxWorkers=1`：最终17项全部通过，37.08秒；另一次4项强退/派发/分享/并行目标回归通过。
- Linux Node 22.23.3：现有 `renderweave-service-test:local` 镜像、`docker run --rm --init`、只读挂载本树并复制到 `/app`（排除 `.git`、`node_modules`、`service/node_modules`、`out`、`outside_context`，复用镜像Linux依赖），先 `npm run build`，再 `./node_modules/.bin/vitest run test/agent-orders.test.ts test/agent-eval-attempts.test.ts test/agent-eval-attempts-cli.test.ts --maxWorkers=1`：3文件28项通过，64.20秒。
- 最终相同Linux路径重建后，`./node_modules/.bin/vitest run test/agent-orders.test.ts --maxWorkers=1`：最终17项全部通过，38.08秒。

决定与操作说明：M323、[订单成本与人工投入](../../../docs/agent-orders.md)，入口已补CLI帮助和代建指南。新增订单各记录/报告 `/1`；不改变旧MCP、轮次或出图合同。独立Spec轴复核发现的人工历史完整性问题已用上述公开反例修复；Standards轴自查确认公开测试接缝、原有评估预重构回归、无新增服务依赖与无私有结构断言。

边界：散列用于内容完整性，不是本机操作者认证；当前费率支持明确的四类互不重复token口径，不猜订阅分摊、复杂提供方计价或远端停止计费时间。交付应在应用后、下一次工作区修改前登记；已登记结果按原件复核。未完成订单的端到端结束时间保持未知。受控执行器和真实MCP用来验证机制，不计真实模型质量或后续留出/真人验收。CONTEXT由集成任务同步更新。

集成复核（2026-10-23）：合入含票10监督层与票16信任边界的主集成后，`npm run typecheck`、`npm run build` 通过；`test/agent-orders.test.ts --maxWorkers=1` **17/17 通过**。保留 MCP 0.15.0 和运行预算，不改变分享白名单与完整历史判定。
### 与票10的最终用量联动复核

合入票10后，新增两个真实CLI强退反例：未生成 `round.json` 时，只收到去重消息累计，或收到稀疏/空 `result`，公开订单报告原先把已知 output=12 抹为0。现在 `round-metrics.ts` 共用 `usageCollector`，按消息ID合并稀疏用量，空result不覆盖已知字段；消息来源保留 `usageSource=messages`，已知小计与未知尝试数同时展示，不允许据此估算完整金额。Linux强退夹具同步核对监督进程与工作进程拥有关系后回收本轮进程组。

红→绿：两个强退公开订单反例先均失败（0≠12），修复后均通过。最终 Windows `npm run build` + `npx vitest run test/agent-orders.test.ts test/agent-eval-attempts.test.ts test/agent-eval-attempts-cli.test.ts --maxWorkers=1`：31项通过，145.21秒；Linux Node22.23.3相同只读镜像路径重建后 `test/agent-orders.test.ts --maxWorkers=1`：19项通过，69.42秒。`npm run typecheck`、`git diff --check`通过。
