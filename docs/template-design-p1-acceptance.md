# 模板设计 P1：边界与区域视觉核查实测

日期：2026-10-22。分支：`template-design`。改前基线：`1a4740b`；核查器最终代码：`c780e52`。范围见[规格](../.scratch/template-design-verification/spec.md)，验收状态以[票据 01](../.scratch/template-design-verification/issues/01-boundaries-and-visual-evidence.md)为准。

**判断：应该引入像素比对，并把低分区域连到模板元素。实现已通过离线测试与两轴 review；它能定位已知问题，但尚无证据证明 P1 使真实 Agent 生成的模板更好。** Haiku 5.5 的首个请求被 OpenCode Go 额度 429 拒绝，模型门槛及真实交接对照未完成。

先看[交互对照页](agent-eval/figures/template-design-p1/index.html)：五组历史候选可以切换，点击最差区域后，参考图、候选局部、差异热图与元素路径同步定位。原始数据在[回放汇总](template-design-p1-evidence.json)，每份宿主报告由其中的 report 路径指向。

## 实现与上下文变化

| 部分 | P0 基线 | P1 行为 |
|---|---|---|
| 边界 | Agent 自己构造请求；宿主成果核查执行当前请求 | 可选宿主计划，原请求加最多 23 个组合；完整复制原数据后仅改指定维度，每例实际渲染 |
| 样式 | 没有按项目规则逐实例核查 | 按实际展开路径核对人工给定的毫米字号、字距、颜色、位置、数量；报告未匹配与未覆盖 |
| 视觉 | 评估器离线保存低分辨率全图 RGB 相似度 | check_outcome 返回全图及局部 SSIM/RGB、最差 5 区域、参考像素坐标、候选毫米坐标、相交元素路径；另可导出热图 |
| 绑定 | 原请求有渲染核查 | 核查计划、候选集合、请求、数据、资源内容及参考图共同入指纹；每次重新计算，审核修改与应用同样重核 |
| 披露 | P0 短核心、DSL 章节按需读取 | 不扩大短核心；只在提供 --checks 时增加计划指针。默认 design 摘要最多 8000 字符，designCase 按需取单用例 |

核查计划保存在轮次的宿主目录，Agent 只读 docs 中的副本。接续继承原计划，保存的计划被修改时拒绝继续。已声明的边界或样式失败阻止成果合格、批准与应用。MCP 合同升至 **0.9.0**，复用 check_outcome，工具数量不变；可选参数 designCase 是本次合同加法。

报告体积有两层约束：宿主保留全局前 40 条失败，每例独立保留前 12 条；未覆盖路径每例前 12 条。总数及 detailsTruncated 保留。给模型的 design 再限制在 8000 字符，超限先省略细节，保留状态、总数和指纹。这个预算不等于整个工具回答或整个上下文的 token 上限。个人编码 skills 的 P0 隔离配置没有改变。

用法、计划字段、算法和边界见[核查说明](template-design-checks.md)。本批未实现语义信息逐项核准；uncovered 只说明可见叶元素未被样式规则覆盖，不能证明数据字段均已呈现。M402 回放计划的 styles 故意为空：不能把未经人核准的字号当项目标准。两组 P0 修订候选的 reference 用例各有 133 个未覆盖实例。

## 同一核查器回放五组历史候选

以下全部是 **P0 已有模型产物**，使用 c780e52 核查器和同一份 [M402 计划](../scripts/agent-eval/scenarios/m402/design-checks.json)离线重放，没有重新调用模型或修改候选。组合包括原数据、两站保留徽标、两站徽标缺省、50 站、50 站加 1500 mm 宽、本站 0、本站 35、12 字站名。样本来源及指纹见[汇总 JSON](template-design-p1-evidence.json)。

| 历史候选 | 原生成代码 | 组合通过 | 全图 SSIM | 全图 RGB 相似度 |
|---|---|---:|---:|---:|
| 改前第 1 次 | 8f845f8 | 8/8 | 0.6899 | 0.9273 |
| 改前第 2 次 | 8f845f8 | 8/8 | 0.6303 | 0.9195 |
| P0 初版失败样本 | 0b6140f | 7/8 | 0.5608 | 0.8909 |
| P0 修订第 1 次 | c2aac1f | 8/8 | 0.5585 | 0.8897 |
| P0 修订第 2 次 | c2aac1f | 8/8 | 0.5630 | 0.8799 |

结果支持“起步减量没有自动带来视觉提升”的判断。这五个候选的样本量不能估计稳定成功率；上表也不是 P1 生成质量的前后对照。

**边界复现：** 初版失败样本仅在“ 两站+原徽标 ”报 render.sizeOutOfRange：站徽子模板实际 362 × 8 mm，声明宽度上限 100 mm，路径为 `线路牌主模板/站点区/站点循环[2]/列底/站徽循环[1]`。“两站+徽标缺省”通过。这说明从完整原数据派生组合可以执行先前被自造样本漏掉的路径，见[报告](agent-eval/reports/template-design-p1-initial-failure.json)。

**区域定位：** P0 修订第 2 次的最差区 SSIM 为 **0.2732**；候选框 `(616.43, 82.32, 61.79, 41.16)` mm，对应参考图 `(2912.20, 389.15, 291.90, 194.57)` px。关联站列 30–33 的站名。对照页能看到这些站名的尺度与纵向位置差异，下一步可沿这些路径核对字号和布局。布局框相交只给排查线索，不构成因果判断。

比对前先核对画板比例，偏差大于 1% 返回 alignmentRequired；本批参考整图 3496 × 780，比较采样 2048 × 457。SSIM 使用 7 × 7 均匀窗口，不能与其他参数版本或旧评估器 437 × 98 的 RGB 分数混比。大片相同背景仍可抬高全图分数，所以保留最差区域。旋转、遮挡、文字语义正确性和任意透视照片不由本批解决，相似度没有任意“及格线”。

复现单组（输出目录须未存在，父目录须已存在）：

```powershell
npm run build
node scripts/verify-template-design.mjs --round out/p0-after/run-1/m402-template/template --plan scripts/agent-eval/scenarios/m402/design-checks.json --out out/p1-replay-new
```

该失败样本退出 1；另外四份输出退出 0。原始轮次和资源属于本地不入库材料，换设备需按[开发环境](dev-setup.md)准备；仓库中的报告、图片与交互页可直接查看。

## 测试与 review

已执行 `npm run typecheck`、`npm run build`，均通过。`npx vitest run --project engine`：**45 个文件、957 个测试通过，40.51 秒**。其中 `npx vitest run test/design-verification.test.ts test/mcp.test.ts`：2 个文件、42 个测试通过，6.21 秒，属于 957 项的子集。服务和 Docker 测试未运行，本批未改出图服务 API。

公开接缝覆盖 5.5/11 mm 在两种 DPI 下的判断、所有实例扫描与未覆盖、原数据可选字段保持、图像一致/差异/比例/哈希、灰度 SSIM 解析值、候选/数据/请求/资源/计划变更、运行与 MCP 共用指纹、接续计划、审核阻断，以及 24 个组合的摘要体积和后段失败查询。

两轴审查固定基线 `1a4740b`，最终代码 `c780e52`。Standards 剩余硬问题 0、possible smell 0；Spec 剩余 finding 0。发现并修复了两个问题：

- 初版完整报告可能超过 MCP 40,000 字符限制，工具退化为错误；两轴分别复现约 64.6k 与 91.6k 字符。修复为独立 8000 字符摘要预算和按用例查询。
- 仅从全局前 40 条失败中过滤单用例，会丢掉后段用例的明细。修复为每例独立保留失败。24 × 12 = 288 条失败的公开 MCP 回归验证末尾用例仍返回自身原因及路径，且不超摘要预算。

交互页用本机 Playwright/Chromium 检查五个候选各五个区域、图片加载、单一区域选择与标注框；1440 px 桌面和 390 px 手机宽度无横向溢出，无页面脚本错误，并查看截图核对局部图及标注。

## 真实模型与交接的未完成项

真实调用使用 OPEN_CODE_API_KEY 环境变量、主/小模型均 claude-haiku-5-5、Claude Code 2.1.296、MCP 0.9.0、jobs=1。[原始失败报告](agent-eval/reports/2026-10-22-template-design-p1-incomplete.json)保留当时提交 **229fd2c**；不把它改写成最终 c780e52。

第一个 M402 数据定义请求即返回 `Request rejected (429) · Go usage limit exceeded`，0 输出 tokens、0 有效样本；评估器停止派发其余 7 个单元，gate 为 incomplete。未更换模型或凭据绕过额度。P0 合同 0.8.0 的通过结果不能替代本次 0.9.0 门槛；真实阈值停止及接续峰值对照也尚未执行。

**额度复查（2026-10-22 10:17 PDT，America/Los_Angeles）：** 用户要求复查并继续，因此在干净的 5352393 上重新 build 后，执行下列最终版命令。首请求仍报相同额度 429，单轮 2310 ms、0 输出 tokens，评估器停止其余 7 个单元；[本次原始报告](agent-eval/reports/2026-10-22-template-design-p1-final-incomplete.json)为 incomplete，没有有效样本。2310 ms 只是失败调用耗时，不能算模板设计耗时；上下文峰值与新像素相似度均未测得。真实交接对照没有启动。

本次可复用的历史对照是下面这组 P0 新建模板结果，每组两次的算术平均。上下文与耗时来自[真实模型记录](template-design-p0-model-eval.json)，像素分数来自同批候选用最终核查器的[离线回放](template-design-p1-evidence.json)。这组数据不替代 P1 或交接实验：

| 指标 | P0 改前 8f845f8 | P0 修订后 c2aac1f |
|---|---:|---:|
| SSIM（2048 × 457，越高越接近） | 0.6601 | 0.5607 |
| RGB 相似度（相同采样） | 0.9234 | 0.8848 |
| 单请求上下文峰值 tokens | 125,601.5 | 120,896.5 |
| 单次模板设计耗时，分钟 | 8.40 | 7.63 |

上下文峰值下降 3.75%，耗时下降 9.11%，像素相似度下降。两次样本和历史运行的环境波动不支持稳定效果推断。额度恢复时间未由本次错误提供。

额度恢复后，沿用以下最终版 label/out 续跑即可；当前仅增加文档与报告，不改变运行代码或资料。若后续修改运行代码或资料，则重新建立 label/out，保留每批真实 provenance：

```powershell
npm run build
npx tsx scripts/agent-eval/run.ts --repeat 2 --jobs 1 --model claude-haiku-5-5 --small-model claude-haiku-5-5 --key-env OPEN_CODE_API_KEY --design-checks scripts/agent-eval/scenarios/m402/design-checks.json --label template-design-p1-final --out out/p1-live-final --reports out/reports
```

再从同版无阈值模板轮次选基线，预先登记阈值及选择依据，运行 `node scripts/agent-handoff-eval.mjs --baseline <该轮次> --limit <输入tokens> --out <新目录>`。仅在阈值停止后接续一次，峰值取各轮最大值，计费用量与时间相加，并用原场景评分单独核对质量；发生质量失败照实保留。脚本就绪不等于这项实验通过。
