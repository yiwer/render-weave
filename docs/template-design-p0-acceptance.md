# 模板上下文 P0：实现与实测

日期：2026-10-22。分支：`template-design`。改前：`8f845f8`（修订后方案，尚未实施）。实现、规格和 ADR 见 [票据 01](../.scratch/template-design-context/issues/01-controlled-context.md)、[规格](../.scratch/template-design-context/spec.md)、[ADR-0023](adr/0023-agent-context-handoff.md)。本次落地上下文 P0，票据 34/35 的信息覆盖及样式核查不在本次验收内。

## 已实现的行为

| 部分 | 改前 | 改后 |
|---|---|---|
| 任务入口 | 模板任务要求先读全部 docs，混有数据提取规则 | 短任务入口 + 834 字符核心；客户原文、需求与数据基准保留 |
| DSL | 17,526 字符整篇参考，另可通过 MCP 重复取回 | 索引 + 9 章，由同一原文生成；完整参考逐章可还原，完整示例保留 |
| 领域约定 | 提取与模板内容一起读 | 适用条件与模板章节；提取资料不复制 |
| 占用观测 | 轮次末累计 usage，不能直接看单请求峰值 | context.json 按 message ID 去重，缓存计入有效输入，记录峰值/压缩/工具体积与运行时清单；未知不记 0 |
| 上下文停止 | 只有轮数/额度停止 | 可选 context-limit；响应 usage 达阈值后停止，保存已有成果及短交接，不自动重试 |
| 恢复 | previous/ 全部旧记录及反馈 | 短交接优先，历史按问题取回；输入、资源内容、候选变化或交接被改则旧进度失效 |
| skills | restricted + 独立配置目录，仍登记 16 个内建 skills | 另加 disable-slash-commands，实际 skills 清单为空；开发者个人配置不变 |

上下文阈值是运维参数，不是行业通用“注意力溃散窗口”；它也不能阻止已发送的超大请求。stage 是 Agent 自述，不是阶段状态机，不会自动清空历史。进度保存不保证每次中断前都有 state；没有时从当前候选与原始要求继续。

## 改前/改后本地实测

运行真实 Claude Code 2.1.296，经公开 runAgentTask 启动真实 MCP。两个版本使用同一 M402 项目说明、工作区、请求、资源。模型端点为本地 SSE 脚本，要求取回同一起步资料：改前遵循全读，改后读短资料及前三章。示例图使用同一个有效占位图且不读图，不设计模板。**它验证装配和上下文体积，不测模型自主检索、视觉质量或真实 token。**

计量单位为 JSON 文本封套的 UTF-16 字符数（system + messages + tools，含历史与 Read 包装）。

| 指标 | 改前 | 改后 |
|---|---:|---:|
| 首请求文本封套 | 21,238 | 20,590 |
| 起步资料取回后文本封套 | 54,063 | 29,575 |
| 读取文件数 | 6 | 9 |
| 脚本端点请求数 | 2 | 3 |
| 运行时登记 skills | 16 | 0 |
| 运行时工具数 | 13 | 13 |
| MCP rw 状态 | connected | connected |
| 工具调用错误 | 0 | 0 |
| Matt Pocock 标记/编码审查正文 | 未发现 | 未发现 |
| 根目录 owner 指令 | 未发现 | 未发现 |

最终复测起步资料取回后减少 **45.30%**，代价是按需取章多一次请求。两边工具定义仍为 10,511 字符，系统提示仍为 6,520 字符；主要收益来自减少任务资料，不应把总收益归因于禁用 skills。内建插件仍有两个元数据条目，不能宣称“所有插件都被移除”。完整捕获摘要见 [JSON](template-design-p0-context-audit.json)。初次试测为 54,554 → 30,032（44.95%）；最终补齐成果原因枚举后重新采集。绝对字符数还受运行时附加消息与轮次路径长度影响，比较应使用同批前后配对值。

复跑（两个目录须已 npm run build；输出目录用新的）：

```powershell
node scripts/agent-context-probe.mjs --before out/p0-baseline --after . --claude D:/nodejs/node_global/node_modules/@anthropic-ai/claude-code/bin/claude.exe --out out/p0-context-probe-final
```

基线目录来自 `git archive 8f845f8`，附同一依赖和构建产物。脚本不接外部模型，不记录请求头、凭据或完整模型请求正文；usage 是明确的合成值，不列为 token 测量。

## 测试与 review

公开接缝测试涵盖短资料/章节完整性、缓存与重复 usage、未知 usage、压缩事件、工具结果文字/图片体积、非法预算、阈值主动停止、有效 outcome 与 hostRecovery 两种恢复、损坏/过大 state、输入/资源/候选/交接变更失效、审核修改后续接。

已执行 `npm run typecheck`、`npm run build`，均通过。修复后的 `npx vitest run test/agent test/mcp.test.ts`：7 个文件、145 项全部通过。最终 `npx vitest run --project engine`：**44 个文件、947 项全部通过，98.80 秒**。首轮全量测试中编辑了引擎源码，触发记录重放的构建哈希校验（record.buildMismatch）；固定源码后的第一次全量为 44 文件/943 项全过，其后新增的恢复回归已纳入最终 947 项。服务端与 Docker 测试不在本次回归范围，API/MCP 合同未修改。

## Standards

最终剩余硬性问题 0 项，possible smell 0 项。公开接缝、模块边界、渐进披露与个人技能隔离符合仓库标准。增量审查发现候选扫描可能读取以 .json 结尾的目录、阻断轮次落盘（本轴评为 P1）；已改为 lstat 过滤普通文件，无法获得完整快照时只使摘要失效并警告，补了公开入口回归。详见最终源码中的 candidateSnapshot。

## Spec

最终剩余 finding 0 项。初审发现历史反馈约束跨三轮丢失（P1）、新增候选未使旧摘要失效（P2）；已补反馈原文与索引、完整工作候选集合指纹及三轮/空集合回归。增量发现候选目录读取问题（本轴评为 P2），修复后复审通过。未发现范围扩张；A07 的真实模型部分仍按额度阻塞如实记录。

两轴独立审查基线为 8f845f8；Standards 最终 0 项，Spec 最终 0 项。审查不替代上面的测试，也不替代真实模型门槛。

## 真实模型对照：额度阻塞

计划：同一 Haiku 5.5、Claude Code 2.1.296、合同 0.8.0 下，m402-template 和 m402-revision 各 2 次改前/改后对照。基线第一次实际请求返回 **429 · Go usage limit exceeded**；评估器将其标记 invalid 并停止剩余 3 个单元。没有有效设计样本，改后未再调用付费模型。启动时 PATH 只指向 Windows 包装脚本还产生过一次 ENOENT；已使用原生可执行文件修正，该次不计模型失败。

所以本次不能给出真实 token 峰值、模板质量、返工成本、完成率提高的结论。资料变更和 skills 禁用影响运行时，按 M230 正式代建启用前还须四场景各连续两次通过。

额度恢复后的命令（先在基线目录接续，再在本分支目录跑改后；不自动轮询）：

```powershell
$env:Path = 'D:\nodejs\node_global\node_modules\@anthropic-ai\claude-code\bin;' + $env:Path
# 工作目录 out/p0-baseline，保留已有报告接续 invalid 单元
npx tsx scripts/agent-eval/run.ts --label p0-before-native --repetitions 1-2 --scenarios m402-template,m402-revision --jobs 1 --out out/p0-before-native --reports out/reports
# 工作目录为 template-design 分支；全四场景同时覆盖运行时隔离变更
npm run build
npx tsx scripts/agent-eval/run.ts --repeat 2 --jobs 1 --label p0-after --out out/p0-after --reports out/reports
```

基线原始报告：`out/p0-baseline/out/reports/p0-before-native.json`；可跟随分支保存的阻塞摘要见 [模型评估状态](template-design-p0-model-eval.json)。额度恢复后并排核对模型/运行时版本、输入和资料哈希；若模型版本变化，重新建立基线，不能把不同模型的变化归因于 P0。
