# 01: 宿主核准区域反馈与有界续轮

**What to build:** 在已有宿主设计核查中接入可选区域短反馈与完整检查停止。

**Blocked by:** 无

**Status:** ready-for-agent

**Trace:** ../spec.md；M312、M314。

- [ ] A01 核准参考及严格测量
- [ ] A02 有界反馈与渐进披露
- [ ] A03 新鲜候选绑定与完整停止
- [ ] A04 显式预算与中断语义
- [ ] A05 测试、review 与真实模型记录

**测试接缝：** src/index.ts、src/cli.ts 与真实 MCP JSON-RPC；假执行器只代替模型进程。
