# 模板设计 P1：Haiku 5.5 真实评估与交接对照

日期：2026-10-22。分支：template-design。**指定密钥可用，完整模型门槛 8/8 通过；上下文和耗时下降没有带来像素相似度提升。60k 交接能够保存候选并完成任务，收益与代价应分别看。**

## 凭据纠正与实际运行

此前错误地使用了本进程继承的旧 OPEN_CODE_API_KEY。逐作用域只在内存比较后，确认 Windows User 值与用户指定值一致、Process 值不一致、Machine 未设置。旧两次 429 只反映旧进程凭据，撤回“用户指定密钥额度未恢复”的判断。本次每个模型作业先将 User 值赋给子进程环境变量，没有修改持久设置、保存密钥或输出密钥摘要。

读取链路已核对：[src/cli.ts](../src/cli.ts) 的 process.env[keyEnv] → runAgentTask 的 options.key → [src/agent/run.ts](../src/agent/run.ts) 的 ANTHROPIC_AUTH_TOKEN。主模型、小模型和实际响应模型均为 claude-haiku-5-5；Claude Code 2.1.296，MCP 0.9.0。这里证明的是指定凭据本次可成功调用，未查询账户余额或额度恢复时刻。

完整门槛在干净的 **9b4a832** 发起，四场景各两次，共 8/8 通过、10 个实际 Agent 轮次，合计 41.1 分钟。两次 M402 新建模板均为 10/10 压测、2/2 版面断言、8/8 新增组合；模板修改均为 6/10 压测、2/2 版面断言、0 范围违规，符合既有修改任务门槛。所有结果、失败与门槛标准均按原评分保留，见[完整报告](agent-eval/reports/2026-10-22-template-design-p1-key-verified.json)。

两组交接随后在 **d906463** 发起；该提交只增加协议和凭据文档，运行代码与 9b4a832 一致，核查器实现均为 **c780e52**。全程串行，未提供人工设计反馈、修改候选或按质量重试。60,000 阈值及选择依据先写入[实验口径](template-design-p1-live-protocol.md)，没有根据结果调阈值。

## 改前改后实测

每组两次的算术平均；峰值为一次模型请求的有效输入 tokens，含缓存读取与写入，不是累计计费用量。耗时取 round.run.wallMs；交接耗时为停止轮与接续轮之和。SSIM/RGB 越高越接近，所有候选统一用最终核查器按 2048 × 457 采样离线重算。

| 组别 | SSIM | RGB 相似度 | 单请求上下文峰值 tokens | 模板耗时，分钟 |
|---|---:|---:|---:|---:|
| 改前 | 0.6601 | 0.9234 | 125,601.5 | 8.40 |
| P0 修订后 | 0.5607 | 0.8848 | 120,896.5 | 7.63 |
| P1 无阈值 | 0.5407 | 0.8646 | 93,877 | 5.03 |
| P1 60k 停止并接续 | 0.5420 | 0.8694 | 66,196 | 5.43 |

P1 无阈值相对改前：峰值下降 **25.26%**，耗时下降 **40.15%**，SSIM 从 0.6601 降到 0.5407。相对 P0 修订后：峰值下降 22.35%，耗时下降 34.15%，SSIM 也下降。

这些是两次样本的观测差异。历史和当前运行时段不同，不能归因于单一 harness 改动，也不能据此承诺稳定加速或成功率。StaticSchema/工作区快照、示例数据集、示例图、说明及请求哈希一致；当前回放资源内容哈希一致。历史轮次没有独立资源内容摘要，其原运行资源字节是否相同标为未知。历史 MCP 为 0.8.0，当前为 0.9.0；当前四次模板运行使用同一核查计划。完整逐项证据见[对照 JSON](template-design-p1-live-comparison.json)。

| 实际样本 | SSIM | RGB 相似度 | 峰值 tokens | 耗时，分钟 | 边界组合 |
|---|---:|---:|---:|---:|---:|
| 改前 1 | 0.6899 | 0.9273 | 130,106 | 9.05 | 8/8 |
| 改前 2 | 0.6303 | 0.9195 | 121,097 | 7.75 | 8/8 |
| P0 修订后 1 | 0.5585 | 0.8897 | 99,111 | 6.26 | 8/8 |
| P0 修订后 2 | 0.5630 | 0.8799 | 142,682 | 9.01 | 8/8 |
| P1 无阈值 1 | 0.5423 | 0.8639 | 87,378 | 4.49 | 8/8 |
| P1 无阈值 2 | 0.5392 | 0.8653 | 100,376 | 5.56 | 8/8 |
| P1 60k 停止并接续 1 | 0.5348 | 0.8687 | 68,539 | 5.28 | 8/8 |
| P1 60k 停止并接续 2 | 0.5491 | 0.8701 | 63,853 | 5.57 | 8/8 |

P0 初版的失败样本没有删掉，仍在对照 JSON 和[交互页](agent-eval/figures/template-design-p1-live/index.html)中单列：7/8 组合通过，完整原徽标触发子模板尺寸越界；它不并入修订后的均值。

## 交接收益与代价

| 组别 | 停止轮实际峰值 | 接续轮峰值 | 两轮耗时，分钟 | 最终压测、版面、边界 |
|---|---:|---:|---:|---|
| 1 | 64,559 | 68,539 | 2.60 + 2.68 = 5.28 | 10/10、2/2、8/8 |
| 2 | 60,458 | 63,853 | 2.72 + 2.85 = 5.57 | 10/10、2/2、8/8 |

两次均触发 contextLimit 并只接续一次。收到响应 usage 后才停止，所以实际停止值可以超过 60,000；接续轮按实验协议取消阈值，其峰值也可超过 60,000。两组均未发生 Claude Code 自动压缩。中断轮没有完整 result usage，因此交接输出 tokens 总量为未知；JSON 分别保留完整性和去重 usage 的观测下界，不能用下界计算计费节省。

两组都保存了 4 份候选，但 handoff.json 均提示“Agent 未保存进度，按候选与原始要求继续”。实际接续依靠候选、原始要求和通用反馈，未验证完整的设计意图、已尝试方案及待办交接。下一步应在可控检查点保存简短结构化进度，再用同样任务检验它是否减少接续后的重复阅读和耗时；本轮不在运行途中改变协议。

交接组平均峰值相对 P1 无阈值下降 **29.49%**；两轮合计耗时变化 **7.96%**，SSIM 0.5407 → 0.5420。候选恢复可用不等于视觉质量改善，也不等于 60k 是最佳阈值。保留显式阈值配置，暂不将 60k 设为所有模板任务默认值。

## 模板质量与上下文判断

优先补经过核准的样式目标与区域纠偏策略。当前新增核查能执行边界组合、定位像素差异，并把区域连到模板元素，但模型收到分数和路径并没有自动收敛到更接近参考图的成图。应针对字号、信息层级和分区几何建立明确目标，再让 Agent 根据最差区域做少量可验证修正；仅继续压缩上下文不是当前视觉差距的主要解法。

本次 M402 计划的 styles 为空，8/8 代表已声明的边界组合通过，不代表所有样式或语义信息已核准。相似度没有任意及格线，仍需人工看图；全图背景会抬高 RGB，相比单看全图分数，最差区域更适合定位。交互页同时展示原图、最终图、热图、区域分数及相交元素路径，路径是排查线索而非因果证明。

业务 Claude Code 仍隔离个人编码 skills：本批 6 个新建模板会话的系统初始化事件均为 skills: []，MCP 正常连接，每个会话工具共 13 个（4 个文件工具加 9 个项目 MCP 工具）。个人 Matt Pocock 编码 skills 没有注入业务 Agent。核查资料按计划指针与 designCase 披露；P1 不扩大短任务核心。首个无阈值样本实际工具回答中的 design 摘要最大 3514 字符，低于 8000 字符上限；完整上下文峰值仍需按上表衡量，不能把短摘要当成整段历史的预算。

## 验证与复现

引擎代码自 c780e52 未变。此前 npm run typecheck、npm run build 均通过；npx vitest run --project engine 为 45 文件、957 测试通过，40.51 秒。该批代码两轴 review：Standards 硬问题 0 / possible smell 0，Spec finding 0，详见[实现验收](template-design-p1-acceptance.md)。本轮新增真实模型记录和报告，不重复把离线单测当模型质量证据。

本轮交互页用 Playwright/Chromium 验证 9 个候选、45 个区域、图片加载和标注、单选切换；1440 px 与 390 px 宽度无横向溢出、0 页面脚本错误。已查看桌面截图，区域局部图、热图和元素路径对应正确。

本轮证据另做两轴 review：Standards 硬问题 0、possible smell 0；Spec finding 0。Standards 发现的工具数量范围问题已修正并复核：13 个工具仅描述上述模板会话。均值、逐轮峰值与耗时、门槛、失败保留均对回原始记录；链接检查无失效，凭据扫描无命中，git diff --check 通过。

完整门槛使用以下命令；复现时更换 label/out，保留已有证据：

```powershell
$env:OPEN_CODE_API_KEY = [Environment]::GetEnvironmentVariable('OPEN_CODE_API_KEY', 'User')
if ([string]::IsNullOrEmpty($env:OPEN_CODE_API_KEY)) { throw '用户级 OPEN_CODE_API_KEY 为空' }
$env:Path = 'D:\nodejs\node_global\node_modules\@anthropic-ai\claude-code\bin;' + $env:Path
npx tsx scripts/agent-eval/run.ts --repeat 2 --jobs 1 --model claude-haiku-5-5 --small-model claude-haiku-5-5 --key-env OPEN_CODE_API_KEY --design-checks scripts/agent-eval/scenarios/m402/design-checks.json --label template-design-p1-key-verified --out out/p1-live-key-verified --reports out/reports
node scripts/agent-handoff-eval.mjs --baseline out/p1-live-key-verified/run-1/m402-template/template --limit 60000 --out out/p1-handoff-key-verified-1
node scripts/agent-handoff-eval.mjs --baseline out/p1-live-key-verified/run-2/m402-template/template --limit 60000 --out out/p1-handoff-key-verified-2
```

两组最终候选各运行 verify-template-design.mjs 离线比对和原 scoreTemplates 评分。原始 round/context/stream/handoff 日志留在 out/，仓库存完整门槛报告、逐组评分、核查报告、可比较图片与汇总。原始输入与资源的本机准备见[开发环境](dev-setup.md)。
