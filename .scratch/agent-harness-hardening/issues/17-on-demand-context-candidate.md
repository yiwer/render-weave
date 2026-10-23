# 17: 按需资料策略形成可验证候选并自动检查资料指针

**What to build:** 维护者可以在校准场景中选择保留强制约束的按需资料候选，确认资料和工具引用可达，并生成与现有全量阅读策略可公平配对的输入；默认策略暂不改变。

**Blocked by:** 14

**Status:** ready-for-agent

**Trace:** [父规格](../spec.md) H6、D15–D16；US58–59；A18 的资料策略候选、自动指针检查和配对输入准备子项。配对实跑与收益判定归票据 18。

- [x] 保留现有全量资料策略作为对照，新增可显式选择的按需策略候选；命名、单位、作用域、成果交回、能力与信任边界等强制约束仍在入口可见，默认和既有 effort 决定不变。
- [x] 按需候选以简短资料目录引导按任务阶段读取循环/子模板、文本适配、状态与变量等现有参考；只使用公开 DSL 参考工具已经可达的资料，不增加新的 DSL 语法或另一份规则权威。
- [x] 局部问题按代码或目标聚类，返回必要上下文、实例/源模板位置和续取入口；截断必须明确，不能因压缩资料丢掉必修约束、未知范围或后续页问题。
- [x] 自动检查候选资料目录、DSL 参考、工具合同和共享样例之间的指针与可达性，结果列出通过项、遗留错误及其责任；原数据定义示例的错误指向仍归原票据 20，不在本票重复修复，也不要求原 20 整票关闭后才能验证候选。
- [x] 对原票据 20 的已知遗留错误明确记为未解决，按需候选可通过已可达的正确公开参考验证其路径；检查报告不得因已知责任归属而把错误标成通过。其他新增或由本候选引入的失效指针必须在本票消除。
- [x] 只使用票据 14 的校准场景及其他明确属于校准用途的输入验证资料获取、缺失/无效参考、分页和错误修复引导；不读取留出结果来调整策略，材料不足明确未完成。
- [x] 为两个策略保存可冻结的策略身份、实际资料范围和配对输入，确保后续可固定模型、预算、样本和调度条件比较。当前只用假执行器与公开工具验证可执行性，不运行配对真实模型、不宣称降低成本或提高成功率；实跑、质量守卫和是否改变默认由票据 18 决定。
- [x] 候选策略说明、资料目录、相关工具合同及校准操作指引在本票同步；旧全量资料路径仍可用，候选失效能得到明确错误。同步内容与遗留问题随版本记录，不能留待最后整体验收补说明。

**测试接缝：** 现有评估/Agent 入口的策略选择与实际资料成果，辅以公开 DSL 参考和 MCP 结果；以校准样例和假执行器观察参考可达、约束保留、分页、错误状态与策略身份。真实配对实验不在本票。

## Answer

完成日期：2026-10-23。主实现 `767b091`，参考冻结与审查修复 `3e6b2e3`；同步最新集成 `fdc8a77` 为 `bbd6444`。决定 M322，MCP 合同0.16.0，操作与记录见[资料策略](../../../docs/agent-context-policy.md)、[MCP合同](../../../docs/mcp.md)。CONTEXT由集成任务统一更新。

公开 `agent run` 与评估 CLI 支持 `--context-policy full|on-demand`；缺省full、原全量路径、effort及预算保持不变。候选入口包含原参考逐字摘录的强制约束及完整guide/outcome，阶段目录仅定位现有公开参考。宿主一次保存七份参考/Schema字节，入口与MCP共用，服务启动后不再读活文件；策略身份记录实际可用资料和入口摘要。

`check_outcome.feedback` 给出冻结报告ID；只读 `outcome_feedback` 按代码/目标续取所有局部问题、候选信息、修订差异、实例/源模板位置、未知与待确认。页读不重检、不保存新检查点；修改后需重新检查，下次检查使旧ID失效。单项过长按JSON分片无损还原；首响应总预算兜底保留身份/状态/计数/续页入口并明确 `detailsTruncated`，不能把空摘要当无问题。

`scripts/agent-eval/context.ts --check` 通过真实MCP核对目录、Schema指针、工具合同及共享样例。原票20的错误仍未解决并保留责任，候选以正确 `reference/data-definition` 验证；不存在参考、无效pointer、缺章节均拒绝候选。`--prepare-pair` 只接受票14已登记合成校准资料，保存两组完整身份及执行参数；材料缺失输出ready=false、空arms、退出3，参数漂移在派发前拒绝。

红绿与验收重点：新增策略/工具最初不存在；缺资料计划原先在身份读取阶段报错，现保存未完成计划；固定资料文件缺失/会话中改变、原检查后候选改变、240个覆盖问题后页、700个区域问题、超长未知说明JSON分片、错误/过期报告ID均从公开入口验证。独立Spec审查新增20个合法长区域名反例，原 `check_outcome` 返回76157字符被服务拒绝、续页入口不可达；修复后首响应有界，原始长名称和异常在续页完整还原。中文/英文四任务实际获取目录与反馈后纠偏，模板页含实例及源模板位置；评估入口实际派发8个受控单元并保存on-demand轮次身份。只用假执行器和真实MCP，无远端模型。

验证命令与结果：

- `npm run build`、`npm run typecheck`、`git diff --check`：通过。
- 审查修复前联动：`node node_modules/vitest/vitest.mjs run test/agent-context-policy.test.ts test/agent-dataset-template.test.ts test/agent-eval-identity.test.ts test/agent-eval-feedback-cli.test.ts test/mcp.test.ts --maxWorkers=1`：5文件73项通过，487.89秒。
- 最终同步主线及长名称修复后：`node node_modules/vitest/vitest.mjs run test/agent-context-policy.test.ts test/mcp.test.ts test/agent-eval.test.ts --maxWorkers=1`：Windows 3文件62项通过，249.04秒。
- Linux Node22本地镜像 `renderweave-service-test:local`，`docker run --rm --init` 只读挂载本树并复制到/app（排除.git、宿主node_modules、service/node_modules、out、outside_context），重建后 `./node_modules/.bin/vitest run test/agent-context-policy.test.ts test/mcp.test.ts --maxWorkers=1`：最终2文件40项通过，116.61秒。
- MCP快照用 `vitest -u` 更新并逐项核对：仅新增outcome_feedback及check_outcome续取说明；版本断言与各任务工具清单同步。

Standards自查：没有新增依赖、HTTP服务或DSL语法，测试从真实CLI/MCP和公开报告观察，不导入新的内部函数。独立Spec轴发现的总预算缺陷已用公共反例修复。资料目录、合同、代建指南、决定记录和校准指引同时完成。此结果只证明候选机制可执行；不读取留出结果，不证明真实模型节约或质量改善，也不关闭原票20。票18负责完整配对、成本/质量守卫及默认决定。

集成复核（2026-10-23）：最终分支 `6bcf158` 以 `76207d2` 非压缩合入主集成，无冲突。复核已指出的首响应总预算问题：兜底仍保留内容身份、状态/计数、截断标识和同一冻结报告的完整续页入口；参考固定字节、默认 full、强制约束以及分页不重检的边界保持。

- 主集成 `npm run build`、`npm run typecheck` 通过。
- `node node_modules/vitest/vitest.mjs run test/agent-context-policy.test.ts -t '显式按需|真实MCP的问题|合法超长|公开参考服务' --maxWorkers=1`：4 项通过、4 项未选取，8.47 秒。复核默认入口、同身份续页、合法长区域名称首响应和会话参考固定。
- 合同保留 0.16.0，CONTEXT 同步阶段与能力。未重复双平台全量，分支最终 Windows 62 项及 Linux 40 项的证据保留在上文；两份用户既有未跟踪评估报告原字节未改。


### 首轮正式派发前的来源路径修复（2026-10-23）

本票重新打开：候选1的 `contextPolicy.sources` 将 `agent/README.md`、`agent/tasks/...`、`agent/reference/...` 写成缺首字符的路径。根因是资料目录保留尾分隔符，`materialHashes` 通过目录字符串长度截取时多删一个字符。此前验收只检查身份变化，未核对来源键能否直接定位真实文件，因此没有发现此缺口。

只读逐字节核查候选1和两份计划绑定：15份实际Agent材料映射到15个键，无覆盖或遗漏；七份公开参考/Schema内容完整，`identity.materials` 与候选共同内容清单均按正确路径完整覆盖。候选1仍是零模型观测准备包；修复不改它、票18的32次观测、既有报告或归档。资料来源实现归本票，后续候选2冻结与新计划绑定归票20。

公开评估CLI经受控Agent执行器新增full/on-demand两例：读取 `eval.json` 与轮次provenance，要求来源路径保留真实文件名，完整材料集合一致，并按每个路径读回实际字节核对摘要。修复前两例均因缺首字符失败，日志 `F:/GenCode/render-weave/out/harness-context-source-fix/windows-red.log`；改用平台标准相对路径后两例均通过，日志 `windows-green.log`。不导入私有身份函数，不调用真实模型。

修复后保留原身份格式、MCP合同、默认full、模型和effort；来源键与源码/构建字节改变会自然产生新身份。双平台相关回归完成后在本节记录最终结果，再关闭本票。
