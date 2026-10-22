# 01: 模板轮次以精简上下文启动、观测并可恢复交接

**What to build:** 落实短核心、DSL 章节、逐请求占用、交接与技能隔离。
**Blocked by:** 无
**Status:** resolved
**Trace:** [规格](../spec.md)；2026-10-22 用户要求；A01–A07。

- [x] A01–A02：短模板资料与可追溯章节。
- [x] A03：逐请求统计、缓存、去重、未知与压缩事件。
- [x] A04–A05：显式阈值停止、有效成果/恢复草稿区分、接续与失效。
- [x] A06：真实执行器技能隔离与工具可用。
- [x] A07：测试、两轴 review 和改前改后对照，真实模型阻塞如实记录。

**测试接缝：** runAgentTask、runCli；本机脚本模型端点；真实模型评估命令。

## Answer

2026-10-22：实现短核心、权威参考自动分章、运行时占用报告、显式阈值交接与技能隔离。复审修复历轮反馈丢失、新增候选未使摘要失效、.json 后缀目录阻断保存；客户反馈原文和完整工作候选均保留在恢复路径。

- `npm run typecheck`、`npm run build`：通过。
- `npx vitest run test/agent test/mcp.test.ts`：7 文件/145 项通过。
- `npx vitest run --project engine`：最终 44 文件/947 项通过。
- Standards、Spec 两轴最终剩余问题均 0；详细独立报告见[验收记录](../../../docs/template-design-p0-acceptance.md)。
- 真实 Claude Code 2.1.296 + MCP、本地脚本端点同输入配对：起步资料取回后文本封套 54,063 → 29,575 字符（-45.30%）；skills 16 → 0，13 工具和 MCP 连接保留，前后均未发现 Matt Pocock 正文。不是 token 或模型质量测量。

偏差：真实模型基线首请求收到 429 Go usage limit exceeded，无有效质量比较，未再尝试付费调用；按 A07 明确记录阻塞及接续命令。本票关闭的是 P0 实现与本地验收，不表示 M230 模型门槛通过，也不关闭票据 34/35/38。
