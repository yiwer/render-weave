# 01: 宿主核准区域反馈与有界续轮

**What to build:** 在已有宿主设计核查中接入可选区域短反馈与完整检查停止。

**Blocked by:** 无

**Status:** ready-for-agent

**Trace:** ../spec.md；M312、M314。

- [x] A01 核准参考及严格测量
- [x] A02 有界反馈与渐进披露
- [x] A03 新鲜候选绑定与完整停止
- [x] A04 显式预算与中断语义
- [ ] A05 测试、review 与真实模型记录

**测试接缝：** src/index.ts、src/cli.ts 与真实 MCP JSON-RPC；假执行器只代替模型进程。

## Comments

2026-10-23：A01–A04 已实现，保留 ready-for-agent，A05 尚未达线，不关闭票据。

- main 已合并推送 a986f52；本批实现分支 codex/template-repair-policy。
- 最终 npm test：68 文件、1137 用例通过，1 文件/13 用例跳过；typecheck、build 通过；新增公开测试14项。
- 商品价签107、会议胸牌187项产品核查与既有跨模板清单一致；正确参考全部通过，坏例分别5/7项失败。编译后stdio MCP 0.11.0 两模板均连通9个授权工具。
- Standards/Spec 最终均0剩余finding；已修源和副本漂移、历史反馈、候选归档校验及续轮报告披露。
- Haiku主/小模型首请求使用User作用域OPEN_CODE_API_KEY，429额度错误，0有效样本。旧驱动误用src入口造成MCP连接失败也已修正，并加模型调用前连接预检；原始失败保留。未重试、未跑胸牌或M230四场景，禁止宣布正式放行。
- 记录与恢复命令：docs/template-repair-policy-acceptance.md；原始证据 docs/agent-eval/reports/2026-10-23-repair-policy/。
