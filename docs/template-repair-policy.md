# 可选区域反馈与修复停止

区域短反馈与停止策略成对接入现有宿主设计核查（M314）。没有核准参考时维持原流程；不根据像素总分停止。

## 开启方式

在 `--checks` 的设计计划中增加 `repair`，然后显式给出 `--repair-rounds 2`：

```powershell
node dist/bin.js agent run --task template-revision --workspace <工作区> --resources <资源仓库> --sample <示例图> --brief <说明.md> --request <请求.json> --requirement <修改要求.md> --checks <计划.json> --repair-rounds 2 --max-turns 20 --out <不存在的运行目录>
```

主模型与轻量模型缺省均为 Haiku 5.5，key 从 `OPEN_CODE_API_KEY` 读取。`--repair-rounds` 限制宿主轮次（1–4），`--max-turns` 限制每轮 Claude Code 轮数；两者分别记录。输出是 `round-1/`、必要时的 `round-2/` 和根目录的 `repair-run.json`。

不给 `--repair-rounds` 时仍只调用一次 `runAgentTask`。带 `repair` 的 `--checks` 仍能提供当前差异和停止建议；手动 `--from --feedback` 不受此前停止决定限制。成果仍须经审核与应用，不会自动发布。

## 参考合同

`repair` 含 `approval: "approved"`、`regions: [{id, paths}]`、`references: [{case, geometry, reference}]`。必须为 `reference` 原始请求和计划中每个边界用例各登记一份参考；参考包含依据、画板毫米宽高、非空且路径唯一的文字/图片清单。

- 每个参考元素声明 `path`、`role`、`type`、`boxKind` 与 `box`。文字附完整 `text` 和逐字符 `{text, size, color}`，图片附资源来源 `image`。字号使用真实片段的毫米值，不从框估计。
- `geometry: true` 才检查布局框位置和尺寸。墨迹框与布局框不可混比，遇到墨迹框返回未知；绑定回归可设 `false`，只核对内容、字号、颜色和渲染。
- 每个元素属于且仅属于一个宿主核准区域；额外元素、重复路径、缺失元素、未知测量均不能通过。路径改名或拆分需要人工重新核准参考。
- `plan.reference.sha256` 绑定示例图。`createLayoutReference` 仅从已接受布局生成参考草案；调用方负责核准，不可从待修候选生成“正确答案”。任意 PNG 没有参考布局时，仍需人工/OCR 标注及核准，本功能不自动获得真值。

受控接线示例由 `scripts/agent-eval/repair-policy-live.ts` 生成，参考来自维护模板在固定数据/参数下的正确布局。它是测试参考，不是自动批准客户设计。

## 披露与测量

完整 `repair` 清单只存在宿主的 `design-checks.json`、MCP 上下文和 `check.json`；不复制到 Agent 的 `docs/design-checks.json`。启动核心只增加一段条件指引，个人编码 skills 仍禁用。已有 DSL 章节仍按需读取。

`check_outcome` 每次重算当前候选。默认 `assessment.repair` 返回指纹、检查数量、失败/未知数、停止建议与反馈；最多两个不同区域、1200 字符，优先内容、字号、位置、尺寸、颜色。缺失元素不编造候选路径；反馈没有列出的区域不表示通过。用 `designCase` 按需查看单用例失败证据，设计摘要仍有 8000 字符上限。

停止要求技术合格、无待确认项、完整非空登记清单均已测量且通过。指纹覆盖候选、请求、数据、计划、示例图、定义与资源内容；交回时宿主重新执行检查，不信任先前工具结果或 Agent 自述。旧 `style.passed` 与 SSIM/RGB 不参与停止。

每轮决定先写入 `repair-run.json` 才考虑续轮。`complete` 才表示登记范围完成；`budget` 表示用尽预算，`runtimeStopped` 表示运行/额度/上下文中断，`checksUnavailable` 表示没有可用核查，`pendingReview` 需人工处理，`inputsChanged` 表示宿主输入漂移。这些中断不自动重试，CLI 返回失败码。输入不变且仍有可测量差异时，下一轮使用当前两条短反馈和原有候选交接。

这些测量覆盖文字/图片内容与布局，不证明遮挡、裁剪后的最终墨迹、所有形状外观或人工审美认可。人工视觉审核继续保留。真实模型门槛及接线记录见本票据验收，未通过前不扩大为默认流程。
