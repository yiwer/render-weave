# 01: 数据定义与数据集有 DSL 1.0 参考、Schema 与兼容承诺

**What to build:** DSL 使用者能读到数据定义 DSL 与数据集文档的完整参考，并用 JSON Schema 在编辑器中校验；兼容策略写成 ADR。

**Blocked by:** 无

**Status:** resolved

**Trace:** 第三阶段 PRD；用户故事 25–29；验收 A01、A02、A03。

- [x] 人读参考（`docs/dsl/`）覆盖 `renderweave-schema/1` 的全部写法与数据集文档格式：字段类型、约束、引用、列表、命名规则、编译产物要点与已知限制。
- [x] `schemas/` 发布数据定义与数据集文档的 JSON Schema 2020-12。
- [x] 一致性测试：
  - 仓库内全部有效的数据定义与数据集语料都通过 Schema；
  - 未知键、错类型、错枚举、缺必填的变异样本，被 Schema 与解析器同时拒绝。
- [x] Schema 通过而引擎拒绝的语义检查有类别清单，例如约束冲突、引用不存在、版本号与发布不符；每类至少一个测试。
- [x] Agent 参考迁到 `agent/reference/`，与人读参考同源，示例在测试中校验为 0 问题。示例改用第三个领域（例如会议胸牌），既不是线路牌，也不是票据 09 验收用的商品价签，避免向 Agent 泄露验收答案（M222）。
- [x] 写 ADR：DSL 1.0 兼容策略，包括 1.x 只做加法、继续拒绝未知键、升到 `/2` 的条件与迁移说明。
- [x] 现有测试全部通过，共享样例不改动。

**测试接缝：** Schema 与解析器的一致性测试，语料取自仓库现有文档，另加变异样本；不为解析器内部函数单独写测试。

## Answer

2026-10-14 已完成。

**成果**

- 人读参考：[docs/dsl/README.md](../../../docs/dsl/README.md)（五种文档索引、Schema 与引擎的分工、编辑器关联方法）与 [docs/dsl/data-definition.md](../../../docs/dsl/data-definition.md)。后者包括顶层与字段、九种类型与约束、列表与引用、发布与版本、编译产物要点、数据集文档、会议胸牌示例、Schema 之外的检查、已知限制。
- JSON Schema 2020-12：`schemas/data-definition.schema.json`（按 type 用条件分支约束 constraints、items、ref）与 `schemas/dataset.schema.json`。
- Agent 参考：`agent/reference/data-definition.md`，示例改为会议胸牌（M222）。验证脚本 `scripts/m190/run.mjs` 改为读取它，旧的 `scripts/m190/dsl-reference.md` 已删除。
- [ADR-0016](../../../docs/adr/0016-dsl-1-compatibility.md)：冻结现行写法，1.x 只做加法，继续拒绝未知键，`null` 不等于"没写"。
- 公开入口 `checkDslDocument(document, source?)`（`src/dsl.ts`）：识别文档种类并做单份文档的自足检查。一致性测试经它进入，票据 03 的校验工具将复用它。

**一致性测试**（`test/dsl-schema.test.ts`，15 项）

- 语料：仓库内 `.json` 与 Markdown 中的 json 代码块。数据定义 10 份、数据集 6 份全部有效且通过 Schema，其中 6 份来自文档示例。
- 变异：数据定义 42 种、数据集 8 种结构错误，每种都至少用到一份语料，全部被 Schema 与引擎同时拒绝。
- 语义检查清单：约束冲突、正则不合法、有效数字超过 15 位、字段名称重复，各有用例，并断言清单与用例一一对应。需要其他文档的类别（引用不存在或成环、版本号不符、数据不合格等）在参考中列出代码，由 `schema.test.ts`、`render.test.ts` 已有用例覆盖。
- 两份参考的示例：依次发布、数据集经引擎校验，均为 0 问题；两份参考都覆盖 Schema 中全部顶层键、字段键、类型与约束关键字。
- 能否变红已验证：临时撤回 `constraints: null` 的收紧，4 份语料立即报"Schema 拒绝，引擎接受"；把示例座位改为 300，示例测试报 `dataset.constraintViolated`。两处都已还原。

**验证**：`npm test` 32 个文件 / 637 项通过（本票新增 15 项）；`npm run typecheck`、`npm run build` 通过。共享 M402 样例与码图样例未改动。

**偏差与说明**

- 为让 Schema 与引擎同进同退，收紧了解析器中几处原先静默接受的写法（M223），仓库语料中都不存在这些写法。模板与请求里的引用对象留待票据 02。
- 测试中的 ajv 关闭了 `strictRequired` 与 `strictTypes`：这两项是 ajv 自己的额外要求，标准写法的条件分支会触发；其余严格检查（如拼错的关键字）保留。
- Agent 参考不再列出 MCP 工具，工具由 MCP 服务自行描述（票据 03）。
- M211–M217 的评估是用旧的价签示例跑的；参考示例换成会议胸牌后的复测，属于票据 08 的评估门槛。

