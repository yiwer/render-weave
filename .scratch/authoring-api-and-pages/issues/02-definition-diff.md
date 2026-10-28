# 02: 引擎给出两份数据定义之间的字段级差异

**What to build:** 引擎公开入口 `diffDefinition(before, after)`，按字段路径列出增、删、改，改动细到属性键。

**Blocked by:** 无

**Status:** resolved

**Trace:** [P1 PRD](../spec.md)「数据定义差异（引擎）」；用户故事 8、12；验收 A03；M299。

- [x] 按字段路径列出新增、删除与修改的字段；修改列出改了哪些属性键：显示名称、类型、约束、必填、引用的静态数据定义版本。
- [x] 列表与数据定义引用的子字段带父路径；字段顺序变化单独标出，不算增删。
- [x] 改了字段名称表现为一删一增（字段名称是身份，ADR-0005），并标为"会影响绑定"。
- [x] 按规范化 JSON 比较，与 `diffTemplate` 的口径一致；纯函数，不读存储。
- [x] 两份输入任一读不了时，回答问题清单，问题码沿用 `checkDslDocument` 的。
- [x] 从 `src/index.ts` 导出，`docs/dsl/` 里补一段用法。

**测试接缝：** 引擎公开入口；输入用 `docs/examples/m402-dsl/` 的两份数据定义及其构造的改动版本。

## Answer

2026-10-27 完成。公开入口 `diffDefinition(before, after)`，说明见[数据定义 · 比较两份数据定义](../../../docs/dsl/data-definition.md#比较两份数据定义)。

**成果**

- **`src/definition-diff.ts`**，从 `src/index.ts` 导出 `diffDefinition` 与 `DefinitionDiff`、`FieldChange`、`FieldOrderChange`。回答 `{ problems, definition, fields, order? }`：
  - `fields`：每个有改动的字段一条，`path` 是字段名称，`change` 为 `added` / `removed` / `changed`。新增带 `after`、删除带 `before`（数据定义里的原样内容），修改带 `properties`；`properties` 用 `diffTemplate` 的 `PropertyChange`，页面可以共用一个渲染组件；
  - 属性键：`displayName`、`description`、`required`、`type`，约束一个约束一条（`constraints.maxLength`、`constraints.enum` 等）；
  - 列表与引用的子键带父路径：列表元素是 `items.type`、`items.constraints.*`、`items.ref.version`，引用字段自己是 `ref.name`、`ref.version`，路径是所在字段；
  - 改字段名称是一删一增，删去的一条带 `affectsBindings: true`；新增、修改的没有；
  - `order`：两边都有的字段名称各按各自的次序，只在顺序变了才有，不算增删；增删造成的位移不触发它；
  - `definition`：`name`、`displayName`、`description`；`version` 每次都不同，不参与比较；
  - 读不了：`problems` 非空，其余为空。不是数据定义（含无法识别）报 `input.unreadable`，数据定义有问题沿用 `checkDslDocument` 同一份问题（码、等级、位置不变），消息前加"改前的数据定义：""改后的数据定义："，两边都有问题就都列出。
- **比较的口径**：比解析后的模型加说明，不比原文，所以键的先后、`required: false` 与不写、图片省略 `allowedSources` 与两种来源都写都算没改；这与编译产物是否变化一致。值用规范化 JSON 比较。
- **预重构**：`canonical` 从 `src/agent/diff.ts` 挪到 `src/util.ts`，`diff.ts` 原样再导出，8 个既有调用方不动；数据定义差异与 `diffTemplate` 因此是同一个函数，不是照抄一份。
- **文档**：`docs/dsl/data-definition.md` 新增「比较两份数据定义」：调用方式、结果各项、规则与一个完整示例（示例输出取自真实运行，调用片段用 `./dist/index.js` 跑过）。

**验证**

- `npx vitest run --project engine test/definition-diff.test.ts`：20 项通过，只经 `src/index.ts`，输入是 M402 的"线路牌 v1""停靠站点 v1"和从它们构造的改动版本：
  - 无改动（键序、版本号、缺省写法不算）；
  - 增、删、改与属性键，改名一删一增并带标记；
  - 列表元素与引用的版本，字段在列表与引用之间换类型；
  - 顺序单独标出，增删造成的位移不算；
  - 数据定义自身；两份 M402 数据定义整个不同；
  - 读不了（模板、无法识别、`null`、字符串、数组，定义有问题、两边都有问题）；
  - 纯函数（不改输入、重复调用相同、可序列化）。
- 变异检查：去掉 `affectsBindings`、让顺序比较恒为否，4 项测试失败，还原后 20 项通过。
- `npm run typecheck`、`npm run build` 通过。
- **全量测试**（本票改动在 `util.ts`、`agent/diff.ts`、`index.ts` 与新文件，没动渲染与服务）：
  - 同机有另外两个会话在跑全量测试，CPU 长期 90–100%。默认并发的 `npm test` 先后两次分别 45、61 个文件失败，全是 60–180 秒超时与抢 `fixtures/resources` 写锁，不是断言错误；
  - 限 4 个 worker 的 `npx vitest run --maxWorkers=4`：84 个文件里 67 个通过，1,273 项通过、69 项失败、20 项跳过，服务（`service` 项目）全部通过；失败的 15 个文件全是 Agent harness 的重型集成用例（拉子进程、等检查点文件），没有一个碰数据定义或差异；
  - 这 15 个文件逐个单独重跑（含全部会 import 被挪动的 `canonical` 的模块）：`agent-stagnation` 25、`agent-execution` 14、`agent-candidate-selection` 13、`agent-checkpoint` 15、`agent-eval-identity` 19、`agent-concurrency` 9、`agent-resource-identity` 12、`agent-budgets` 17、`agent-eval-feedback-cli` 10、`agent-eval-transcription` 22 项全过，`agent-orders` 通过；`agent-apply-recovery`、`agent-eval` 各有 1 项在批次里超时或抢锁，单独跑通过；
  - 仍不过的两项与本票无关：
    - `agent-context-policy` 的"票14双语四任务"（十几次 `tsx` 子进程串起来的真实 CLI 链）在 180 秒用例上限处超时；**已在基线 `a72c161`（本票之前）上同一台机器实测，同样 180 秒超时**；
    - `agent-candidate-freeze` 的"直接数据集阶段绑定…"在测试里建符号链接时报 `EPERM: operation not permitted, symlink`，是这台 Windows 没有符号链接权限（开发者模式或管理员）；推断，没在基线上跑。

**对验收的偏差与取舍**

- 标"会影响绑定"的只有被删除的字段（含改名的旧名），改字段类型不标。依据是规格「数据定义草案」一节只列了删除与改名；ADR-0005 还提到改类型，那条随 ADR-0008 作废，要不要标由票据 05 的发布预检按模板实际用法再判断。
- 引用的数据定义自己的字段（`stops` 里的 `name`、`road`）不展开：展开要读另一份数据定义，与"纯函数，不读存储"冲突。引用的版本变了时，调用方把被引用的两个版本各交给 `diffDefinition` 再比一次，路径前缀自己加。
- 没有新开 M 编号：取舍都在 M346 与规格的范围内，细节记在本节与参考文档里。

**没做 / 下一步**

- 没有拿到一次 `npm test` 退出码为 0 的干净全量：这台机器上的两项（`agent-context-policy` 的票 14 链、`agent-candidate-freeze` 的符号链接）本来就不过，其余是负载超时。下一步：在没有其他会话抢 CPU、且有符号链接权限的机器上跑一次 `npm test`，预期这两项之外全绿。
