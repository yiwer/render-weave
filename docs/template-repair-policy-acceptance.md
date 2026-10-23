# 可选修复策略接入记录（2026-10-23）

既有 `template-design` 工作已合并并推送至 `main`：`a986f52`。新策略已实现于 `codex/template-repair-policy`，保持显式开启；真实模型验收尚未完成，因此本批接入不并入主线、不宣布正式放行。

合并保留了主线票据 33/34 的提取覆盖与样式核查，也保留短任务核心、按需 DSL、检查点、交接和 skills 隔离。合并 review 发现两条 M305 决定冲突，已将提取覆盖/样式核查登记为 M313。合并版 1123 个测试通过；引擎及服务类型检查、构建均通过。

## 本批接入

- `--checks` 可声明宿主核准的逐用例参考与区域；MCP 0.11.0 通过现有 `check_outcome` 每次给出最多两条区域差异、1200 字符。完整参考保留在宿主；按 `designCase` 获取局部证据。
- `--repair-rounds 1–4` 显式开启串行续轮，每轮 `maxTurns` 不变。只有当前候选技术合格、无待确认项且完整登记检查全部测量通过才停止；预算耗尽与成功分开。
- 下一轮之前和每轮结束时核验源输入、实际继承副本、历轮反馈、候选归档与 Agent 副本；变化或不可读即停止，不携带旧反馈。交回时重算，不相信旧 MCP 报告。
- 默认单轮流程不变；不审批、不应用，手动反馈仍可继续。个人编码 skills 仍不注入业务 Claude Code。

格式、开启命令与测量边界见[使用说明](template-repair-policy.md)。布局清单不覆盖最终遮挡/墨迹与人工审美，像素分数及旧 `style.passed` 不参与停止。

## 离线证据

最终 `npm test`：**68 个文件、1137 个用例通过；1 个文件、13 个用例跳过**。`npm run typecheck`、`npm run build` 通过。14 个新增公开入口用例覆盖空/未核准参考、逐字符测量、绑定回归、两区域反馈上限、旧报告失效、预算/运行停止、手动接续、源与副本漂移、第三轮反馈及候选变化。

产品路径预检用相同跨模板坏例，代码及驱动固定于 `ed28f1b`：

| 模板 | 登记检查 | 正确模板失败项 | 坏例失败项 | 编译后 MCP |
|---|---:|---:|---:|---|
| 商品价签 | 107 | 0 | 5 | 0.11.0，9 个授权工具 |
| 会议胸牌 | 187 | 0 | 7 | 0.11.0，9 个授权工具 |

检查数量与此前跨模板清单一致，覆盖原数据、绑定变化、状态/参数变化。坏例的两个目标退化可能影响多个元素，因此“失败检查项”不等于“人工制造的缺陷数”。这证明接线与判定一致，不能推出模型修复率。

实际价签轮次磁盘文件中，宿主计划 **42,379 字符**，Agent 计划副本 **1,054 字符**，启动 prompt **933 字符**；完整 repair 参考没有复制给 Agent，续轮历史核查也生成短摘要。文件字符数不是模型 token；此次不能报告上下文峰值收益。

Standards review：**剩余 0 项**。修复实际继承输入及历轮反馈漂移，补齐候选归档校验；未发现新增硬标准违规或代码异味。

Spec review：**剩余 0 项**。参考与完整检查、当前候选绑定、有界反馈和显式续轮满足 A01–A04；A05 的有效模型验证仍待完成。

## 真实调用与未完成项

主、小模型均指定 Haiku 5.5，显式从 Windows **User** 作用域读取 `OPEN_CODE_API_KEY`。2026-10-23 01:44 PDT 首次价签调用返回：`429 · Go usage limit exceeded`。宿主返回 `runtimeStopped`，没有发起第二轮、胸牌或四场景 M230 门槛。

**有效模型样本为 0**。记录中的 1.895 秒、峰值 0 是失败调用数据，不能作为修复率、性能或上下文优化结果。真实初始化记录的 `skills: []` 仍可用于核对 skills 隔离。

另发现该次实验驱动从 `src` 经 tsx 导入运行器，导致 MCP 指向不存在的 `src/bin.js`，初始化记录为连接失败。这属于实验驱动缺陷，已改用 `dist` 产品入口，并加入调用模型前的真实 stdio 预检；两模板预检已通过。原始失败完整保留，修正后的驱动尚无有效模型样本。接线脚本现以 3 表示未完成、1 表示质量未达线，避免返回 0 被误读为通过。

证据：[汇总 JSON](agent-eval/reports/2026-10-23-repair-policy/summary.json)、[文件指纹](agent-eval/reports/2026-10-23-repair-policy/files.json)、[原始轮次](agent-eval/reports/2026-10-23-repair-policy/attempt/price/round-1/round.json)、[价签预检](agent-eval/reports/2026-10-23-repair-policy/preflight/price/product-preflight.json)、[胸牌预检](agent-eval/reports/2026-10-23-repair-policy/preflight/badge/product-preflight.json)。密钥不在归档中。

下一步：额度恢复后用新的输出目录重跑两模板接线，再跑 M230 四场景各两次，达线后关闭票据并合并本接入分支。旧失败目录不覆盖。

```powershell
$env:OPEN_CODE_API_KEY = [Environment]::GetEnvironmentVariable('OPEN_CODE_API_KEY', 'User')
$env:Path = 'D:\nodejs\node_global\node_modules\@anthropic-ai\claude-code\bin;' + $env:Path
npm run build
npx tsx scripts/agent-eval/repair-policy-live.ts --out out/repair-policy-live-resume-1
npx tsx scripts/agent-eval/run.ts --label 2026-10-23-repair-policy-0110 --jobs 1 --model claude-haiku-5-5 --small-model claude-haiku-5-5
```
