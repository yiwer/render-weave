# 候选 6 两计划预登记

2026-10-25（记录内原始时间为 UTC）。候选 6 的 21 与原四版本 3 预登记已经完成，四次公开预检退出 0。只做准备，没有 activation、实际模型观测或真实订单；两个计划由 root 唯一串行派发，是否启动仍需独立复核及根任务明确激活。

共同候选为 `sha256:9b8a0ada4a0ac2837a0b231eb44e6da4c405910c9ace50064e4972b2afa356b1`，来源集成提交 `41ae798cf509afb328dbc58137ad44429fe0dbd9`。根任务的七步发布结果已经保存；本登记没有再次冻结或生成绑定。

| 计划 | 公开绑定 | 新登记 SHA256 | 计划状态 |
| --- | --- | --- | --- |
| 21 可信反馈 | `sha256:528117b478d6b44833ae57217ee94861b1dc4c65c22ee552fa5377ebd9b25643` | `fa44cde4782ea604978c07aef4f0ba9cced83410420e8dc2940d8680894ddc2a` | 16 槽全部 not-run；450 个受控种子文件，不计观测 |
| 原四 | `sha256:48a742b1ea7f0d49fa0440d82278a4e015b3a24d3f1247bca789cecbd62d987a` | `598bdc4c40f67ba9ed1a0b08449c37a887cd96d996efed2cde21090ff8874d28` | 8 次业务观测、10 阶段全部 not-run |

实际登记原件：

- `F:/GenCode/render-weave/out/harness21-trusted-feedback-candidate-6/registration.json`；入库同字节副本见 [21 登记](feedback/registration.json)。
- `F:/GenCode/render-weave/out/harness-original38-candidate-6/registration.json`；入库同字节副本见 [原四登记](original-four/registration.json)。

新登记按实际候选 manifest、公共 binding、实验 identity、当前资源及输入逐项重算；旧登记只提供已核准的任务、预算、真值政策与历史出处，没有把旧候选哈希直接换名当新身份。命令逐参数构造，没有对登记全局替换候选数字。全量 10/16 单元重验；候选 5 的英文成功与旧门槛结果均不拼入本次通过数。

21 的 40 个事实引用及 22 个资源与旧候选逐字一致，配置只归一化合同内的路径字段后严格比较，所有判据、预算和反馈不变；实际新种子 450 文件重新计算哈希。输入保全为 570 文件。原四既有 preparation 的 52 文件与 28 个原始来源逐字核对，加新公共绑定等共 89 个输入保全文件。所有旧历史与新种子保持独立来源。

调度继续 full、Haiku 5.5、默认 effort、repeat=2、jobs=1、提取 40/模板 80 轮、1 小时墙钟与停滞阈值 2。自然有效失败保留并按计划继续；M331 host invalid 不重试该单元但继续其他单元，已提交成果清理告警照常评分。明确额度或本批原生 429 写新共享 STOP，不轮询、不换模型、不覆盖失败。

共享协调根为 `F:/GenCode/render-weave/out/harness-acceptance-20/candidate6-execution`；两个登记绑定同一 candidate ID、manifest SHA 与 `STOP.json` 路径。当前该目录尚不存在，因此也没有 STOP 或 ACTIVE 锁。原四激活须引用 21 两段实际 completed 文件 SHA、同候选 ID，以及无共享 STOP 的事实。预登记 status 不代替完成；root 不得自动把缺失结果或未知费用填 0。

公开预检命令（均已运行，移除模型凭据）：

```powershell
node docs/agent-eval/candidate-dispatch.mjs --registration F:/GenCode/render-weave/out/harness21-trusted-feedback-candidate-6/registration.json --segment 1 --preflight
node docs/agent-eval/candidate-dispatch.mjs --registration F:/GenCode/render-weave/out/harness21-trusted-feedback-candidate-6/registration.json --segment 2 --preflight
node docs/agent-eval/candidate-dispatch.mjs --registration F:/GenCode/render-weave/out/harness-original38-candidate-6/registration.json --segment 1 --preflight
node docs/agent-eval/candidate-dispatch.mjs --registration F:/GenCode/render-weave/out/harness-original38-candidate-6/registration.json --segment 2 --preflight
```

启动器源码 SHA 固定为 `ba5ddd036794323b8a178acdcdca6834d1e12b223e1a37e0c84803e85cfa8357`。本次从独立登记树调用同一字节的工具；主线入口相同。启动器本身不在本提交修改，其 Windows 本地进程红绿见 [启动器验证](../candidate-dispatch-validation/README.md)。250 ms 外层观察窗口及无法承诺内层队列零窗口的边界继续保留。

核验见 [verification.json](verification.json)：4 次公开预检成功；7887 个文件 SHA 前后相同，旧 5 两个完整目录的文件/目录集合相同。外部原件在 `F:/GenCode/render-weave/out/harness-candidate6-registration-validation/`，包含 before.json、四次 stdout/stderr 与完整证据索引。生成器为 [prepare.mjs](prepare.mjs)，只能新建，重跑会拒绝已有目录，不用于派发。

人工审核、分钟、金额保持未知，票 21、原38及后续留出关闭条件不变。下一步：独立审核这些登记和输入保全，root 另存明确 activation 后才派发 21；原四随后由 root 单独放行。
