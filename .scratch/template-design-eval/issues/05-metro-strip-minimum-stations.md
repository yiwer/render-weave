# 05: 地铁导乘图约定提醒按最少站数验证被调模板的适用尺寸

**What to build:** `agent/domains/metro-strip.md` 第 11 条补一句：站数最少时每站占的宽度最大，被调模板（站点格）的适用尺寸要容得下；改完用评估集重跑 06。

**Blocked by:** 无

**Status:** ready-for-agent

**Trace:** [父规格](../spec.md)；M336、M338；`tds-main-haiku-5-5` 的 06 未达线。

- [ ] 改 `agent/domains/metro-strip.md` 第 11 条：把"按项目说明的最多站数验证站距"扩成"按最少与最多站数验证"，写明站数最少时每站最宽、被调模板的适用宽度要容得下（`render.sizeOutOfRange`）。只写行业惯例，不写 06 的具体尺寸。
- [ ] 改了 `agent/` 下的资料，按 [Agent 评估](../../../docs/agent-eval.md)「什么时候必须跑」判断门槛：四个门槛场景都不读 `metro-strip`，用资料哈希核对即可；评估集重跑 06（Haiku 5.5，每例 1 次）：

  ```bash
  npm run build
  npx tsx scripts/agent-eval/run.ts --config scripts/agent-eval/template-design/config.json --repeat 1 --label tds-<日期>-metro-min --scenarios tds-06-metro-strip
  ```

- [ ] 结果记进 `docs/agent-eval.md`「模板设计评估集」的表格；若 06 仍在"2 站"上失败，看是约定没起作用还是别的缺陷。
- [ ] 跑完扫 key。

**测试接缝：** 资料改动没有离线测试；靠评估集的真实运行验证。

**背景：** 首轮基线（旧 Agent）06 在"本站 1"上失败，main 的 Agent 上 06 在"2 站"上失败：站点格的适用宽度写成 20–200 mm，2 站时每站要 595 mm。线路牌约定第 8 条写了"只有 2 站时道路段要容得下"，地铁导乘图约定没有对应的提醒。

## Comments
