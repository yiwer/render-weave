# 10: 停止长批次并辨认中断后的完整成果

**What to build:** 操作者能取消运行中的批次：已完成项保留，下一项不再启动。进程意外结束、`batch.json` 没写出时，能辨认哪些项已完整交付，不把残留文件当成成功。

**Blocked by:** 08：35 个本站逐项正式交付，错误项不拖累整批

**Status:** resolved

**Trace:** 第二阶段 PRD；用户故事 21、25、26、28、43；验收 A07、A11。2026-10-13 按 M188 收窄。

- [x] 公开批量入口接受取消信号，CLI 收到 Ctrl+C（SIGINT）时请求取消；当前项完成并提交后停止，下一项不启动，其余项为 `notRun`，CLI 退出码 130。不声称能中断同步 WASM 绘制。
- [x] 开始前取消、两项之间取消、当前项执行中取消三种时机都有可观察结果；取消后的批次照常发布 `batch.json`，汇总写明已取消。
- [x] 新增批次读取入口（公开函数与 CLI `batch-read`）：有 `batch.json` 时按清单报告；没有时扫描受控序号子目录，以已发布的 `record.json` 或 `preview.json` 判定该项完整，整批报告为"未完成运行"，不虚报整批完成。
- [x] 进程在某项内容写入中、该项清单发布前后、`batch.json` 发布前被强制终止：已完整的项可读取和重放，未完成项不会被读成成功。
- [x] 不增加自动重试、自动续跑或后台服务。

已由 08 覆盖、本票不再重复：已有目标与同目标并发拒绝、单项写入失败继续、存储不可用停止调度、失败项显式组成新批次且原批次不变（M181、M183；`scripts/accept-batch.mjs`）。

## Answer

2026-10-13 完成，决定记为 M191–M193，使用与验收说明见 `docs/output-records.md`「票据 10 验收」。

- 取消：`deliverBatch` 的可选 `signal` 只在开始前、建目录前和每项开始前检查。建目录前取消不建目录；运行中取消让当前项完成并提交，其余 `notRun`，`batch.json` 照常发布并带 `delivery.cancelled`。CLI 返回 130；`bin.js` 只为 `deliver` 监听一次 SIGINT，第二次 Ctrl+C 立即结束。
- 辨认：新增 `readBatch` 与 `batch-read --batch`。有 `batch.json` 为 `finished`，核对清单与各项目录一致；没有时为 `unfinished`，只把已发布 `record.json`/`preview.json` 的项认作完成，其余为 `incomplete`。
- 验证：`test/batch-cancel.test.ts` 9 项；`scripts/accept-batch-cancel.mjs` 在 Windows 与 Linux 容器通过，含 Ctrl+C 返回 130（Linux 为真实 SIGINT 与连按两次）和三处强杀点。29 个测试文件、615 项，类型检查与构建通过。
- 遗留：Windows 全量测试偶发 M179 的资源清单提交失败，加入本票测试后 13 轮中 5 轮出现，失败都在其他文件的资源导入；本票测试已改用空后备字体减少写盘，根因待单独排查，票据 13 前须有结论。

**测试接缝：** 通过公开批量入口、批次读取入口与重放入口观察外部行为；CLI 验证取消信号、退出码与文件成果；不测试私有中间结构。
