# 候选4停止后独立来源与计量核验

已核验：572项检查、0项未解释来源异常；精确单列2条CLI本地429错误。旧审计411项与2条告警原样保留，本记录不修改模型结果或业务评分。

- 新审计：C:\Users\Administrator\.codex\visualizations\2026\10\23\01a167fb-6fcb-7771-8713-7be4f73bddf8\harness-live-source-usage-candidate4-stopped-classified.json，SHA256 2486f4f61743af290faa75b6a9f9f0f4dca24691b490c5de79ae2255aad024ed。
- 审计脚本：C:\Users\Administrator\.codex\visualizations\2026\10\23\01a167fb-6fcb-7771-8713-7be4f73bddf8\harness-live-source-usage-candidate4-stopped-classified-audit.mjs，SHA256 00c12c56e286f2328ef40e131b514011e9d2276b846e04dd68d2b16e4f5518a6。
- 旧审计：C:\Users\Administrator\.codex\visualizations\2026\10\23\01a167fb-6fcb-7771-8713-7be4f73bddf8\harness-live-source-usage-candidate4-stopped.json，SHA256 efc7e60170e663c2c50ee3987f1260f3ab3f0349001ac58b0622b1eacba11d3a。
- 快照：2026-10-23T20:54:29.326Z 至 2026-10-23T20:54:30.796Z。

## 来源判断

两条事件同时满足assistant、is_api_error_message=true、error=rate_limit、model=<synthetic>、四项用量严格为0、唯一text为API Error: Request rejected (429) · Go usage limit exceeded。原事件全部字段、原始行号、零起点字节区间及原始行SHA已保留。只有完整匹配者单列；缺标记、不同错误、非零/缺失用量、不同文本或额外内容均仍受模型检查约束。用量聚合仍消费全部原始事件，未过滤或改写零值。

- original38 / 32362262-a3e4-475a-b470-cd46e2865710：stream第64行，字节2403434+950（不含行结束符），事件SHA256 6c6f25719fefa01145127d1468c00a6dc32ce51d9803b13bcc57959c28c0a51e。
- ticket21 / 122928f6-1d85-44b9-b15f-fe1009f9977f：stream第45行，字节660808+950（不含行结束符），事件SHA256 c99c0bda315838c28c974cd6d375aeb4bd750a42ca2dae0f7f2f5f2890dcab7a。

两个计划真实响应均为claude-haiku-5-5，原生CLI初始化2.1.296及执行器SHA与登记一致。此结论是可观测来源核验，不是远端签名认证；providerRevision未知。

## 停止与计量边界

- 原38：7个实际阶段，6封存、1已停止但原记录仍pending/未封存；事后报告5个有效业务结果=4通过/1失败，3未完成槽中包含已启动中断。3个模型阶段未启动；不能把业务槽数与阶段数混用。原始日志已知pending用量另列，不伪造封存、结束时间或完整墙钟。
- 21：13封存尝试，12通过、1额度invalid、3未运行；完整分段墙钟1514118ms。run-2中文定义的626845ms包含临时调试介入，根因未知，不作为无人介入正常收尾或性能证据。
- 原四与21的事后rescore已纳入来源/计量核查；它们不增加观测，不与先前累计报告相加。所有20个attempt的stream、seal、状态和四类已知用量与旧停止快照一致。
- 原四原生日志已知四项总量分别206、5031898、502388、274664，其中未封存部分分别16、237406、45200、41978；只是停止快照已知量。21分别256、5281639、724278、113969。顺序为input、cacheRead、cacheCreation、output。thinking是output子集，不重复相加，实际金额与人工分钟未知。

本次只读文件系统并另存外部审计；未调用模型/产品评分入口，未改候选、源attempt、报告、判据或旧审计。
