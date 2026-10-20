# 01: 派生变量支持乘除取模、按分隔符拆取文本与复合条件

**What to build:** 模板作者与 Agent 可在派生变量中使用 `multiply`、`divide`、`mod` 做数值计算，使用 `splitPart` 按分隔符拆取文本片段（如拆分价格整数与角分、拆分主站名与括号副名），并在 `branch` 条件中使用 `all` / `any` 组合多项结构化比较。

**Blocked by:** 无

**Status:** resolved

**Trace:** [父规格](../spec.md)；ADR-0004（单步运算按名组合，不引入文本表达式）；ADR-0016（DSL 1.x 只做加法）；验收 A01、A02、A03。

- [x] DSL 与静态检查：
  - 数值派生变量（`type: "number"`）新增 `"op": "multiply" | "divide" | "mod"`，操作数为 `left`、`right`（均为数值运算数）；
  - 文本派生变量（`type: "text"`）新增 `"op": "splitPart"`，键为 `of`（`{ "var": 路径 }`，可引用文本、数值、日期、时刻或时间类型的模板变量）、`format`（可选展示格式，当 `of` 为数值/日期/时刻/时间时先按 `format` 格式化为文本，未写时按默认文本输出）、`delimiter`（非空文本字面值或文本变量）、`position`（`"first"`、`"last"` 或 `{ "index": 运算数 }`，序号从 1 开始）；
  - 条件分支 `branch` 的 `when` 除单个比较 `{ "left", "op", "right"? }` 外，支持 `{ "all": [条件…] }`（非空列表，全部成立为真）与 `{ "any": [条件…] }`（非空列表，任一成立为真）；保持单层结构化比较列表，不引入任意嵌套脚本；
  - 静态检查核对操作数类型、`format` 与 `of` 类型的匹配性、必选键与禁止混写其他运算的键；依赖追溯（`dependencies`）完整覆盖新增运算与复合条件，`dataPath` 对计算标量返回 `undefined`。
- [x] 求值与边界处理：
  - `multiply` 与 `mod` 按精确十进制整数缩放计算：除数为 0（`mod`）或结果无法表示为有限且不超过 15 位有效数字时，报告严重问题 `template.evaluationInvalid` 并按缺值处理（与 `add`/`subtract` 一致）；
  - `divide` 在除数为 0 时报告严重问题 `template.evaluationInvalid`；除数非 0 时，为支持 `1 / 3`、折扣率等非有限小数，按十进制四舍五入保留最多 15 位有效数字（去除尾随 0），仅在结果超出有限数值范围时报告 `template.evaluationInvalid`；
  - `splitPart` 将输入（经可选 `format` 格式化后）按 `delimiter` 切分：源值缺失、为空文本、`delimiter` 为空文本或切分后序号超出范围时返回空文本 `""`，不报错（与 `pickItem` 越界一致）；当非空 `delimiter` 在非空文本中未出现时，第 1 段（`"first"` 或 `index: 1`）为原文本，其余位置为空文本。
- [x] 合同与参考同步：
  - 更新模板 JSON Schema、人读参考（含 `docs/dsl/README.md`「1.0 之后的变化」）与 Agent 参考中的派生变量章节；若新增单文档语义检查，同步登记到 `docs/dsl/template.md`「Schema 之外的检查」与 `test/dsl-template-schema.test.ts` 的 `SEMANTIC_CHECKS`；
  - 一致性测试新增正向语料与结构错误变异样本（如 `all` 为空数组、`splitPart` 缺 `delimiter`、混写其他 `op` 的键等），Schema 与解析器同进同退。
- [x] 测试与验收：
  - 覆盖折扣计算（含非整除小数）、奇偶行取模、带 `format: "0.00"` 的价格整数/角分拆字渲染、主副站名拆分、复合条件分支及除零/越界诊断；
  - 现有全部语料、M402 共享样例、golden 与布局快照保持不变；Windows 与 Linux 全量测试通过，记录 M 编号并同步 `CONTEXT.md`。

**测试接缝：** 从公开渲染入口 `render` 与文档检查入口 `checkDslDocument` 进入；DSL 一致性测试在 `test/dsl-template-schema.test.ts`。

## Answer

- **完成日期**：2026-10-19
- **决定记录**：`M251`（`docs/discovery/requirements.md`）
- **验证命令与结果**：
  - `npm run typecheck`：0 错误
  - `npm run build`：通过
  - `npx vitest run test/variables.test.ts test/dsl-template-schema.test.ts`：2 个测试文件、47 项测试全部通过
  - `npx vitest run`：39 个测试文件、788 项测试全部通过，现有语料、M402 共享样例、golden 与布局快照无变化
- **成果路径**：
  - 引擎实现：`src/decimal.ts`、`src/template/model.ts`、`src/template/declarations.ts`、`src/template/check.ts`、`src/template/scope.ts`
  - 契约与参考：`schemas/template.schema.json`、`docs/dsl/template.md`、`docs/dsl/README.md`、`agent/reference/template.md`
  - 测试：`test/variables.test.ts`、`test/dsl-template-schema.test.ts`
- **验收偏差**：无（Agent 评估门槛按父规格 A08 在整批票据收尾时统一复跑）。
