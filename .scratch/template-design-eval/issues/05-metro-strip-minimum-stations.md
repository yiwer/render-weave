# 05: 地铁导乘图约定提醒按最少站数验证被调模板的适用尺寸

**What to build:** `agent/domains/metro-strip.md` 第 11 条补一句：站数最少时每站占的宽度最大，被调模板（站点格）的适用尺寸要容得下；改完用评估集重跑 06。

**Blocked by:** 无

**Status:** resolved

**Trace:** [父规格](../spec.md)；M336、M338；`tds-main-haiku-5-5` 的 06 未达线。

- [x] 改 `agent/domains/metro-strip.md` 第 11 条：把"按项目说明的最多站数验证站距"扩成"按最少与最多站数验证"，写明站数最少时每站最宽、被调模板的适用宽度要容得下（`render.sizeOutOfRange`）。只写行业惯例，不写 06 的具体尺寸。
- [x] 改了 `agent/` 下的资料，按 [Agent 评估](../../../docs/agent-eval.md)「什么时候必须跑」判断门槛：四个门槛场景都不读 `metro-strip`，用资料哈希核对即可；评估集重跑 06（Haiku 5.5，每例 1 次）：

  ```bash
  npm run build
  npx tsx scripts/agent-eval/run.ts --config scripts/agent-eval/template-design/config.json --repeat 1 --label tds-<日期>-metro-min --scenarios tds-06-metro-strip
  ```

- [x] 结果记进 `docs/agent-eval.md`「模板设计评估集」的表格；若 06 仍在"2 站"上失败，看是约定没起作用还是别的缺陷。
- [x] 跑完扫 key。

**测试接缝：** 资料改动没有离线测试；靠评估集的真实运行验证。

**背景：** 首轮基线（旧 Agent）06 在"本站 1"上失败，main 的 Agent 上 06 在"2 站"上失败：站点格的适用宽度写成 20–200 mm，2 站时每站要 595 mm。线路牌约定第 8 条写了"只有 2 站时道路段要容得下"，地铁导乘图约定没有对应的提醒。

## Answer

2026-10-26 完成。

- **约定**：第 11 条改为"最少与最多站数都要验证"三小条：站数最多时看竖排站名与换乘标签；站数最少时每站最宽，站点格的适用宽度要容得下，否则报 `render.sizeOutOfRange`；首站没有已过站、末站没有未到站。没写任何尺寸。
- **门槛核对**：`scripts/agent-eval/config.json` 的四个场景（`m402-definition`、`m402-template`、`m402-revision`、`366-transcription`）都是 `domain: route-sign`；`agent/` 下没有别的文件引用 `metro-strip`。对照 `out/agent-eval/tds-main-haiku-5-5/eval.json` 冻结的资料哈希（同一 main 提交 125baad），23 个资料文件里只有 `agent/domains/metro-strip.md` 变了，按 M230 不重跑门槛。仓库里留存的门槛报告（最近的是 2026-10-21 的票据 17 一组）早于 main 后来自己的资料改动，拿来比对会混进无关差异，所以没用它们。
- **重跑**：`tds-2026-10-26-metro-min`，Haiku 5.5，06 达线：压测 9/9（含"2 站"）、版面 15/15，15.2 分钟、80 轮，相似度 0.909。站点格适用宽度 40–620 mm（2 站时每站 595 mm）；成果说明的"已核对的边界"列出"2 站、本站序号 2（4 个换乘标签）""2 站、本站序号 1"。2 站的出图目视正常。
- **key**：`node scripts/scan-keys.mjs out/agent-eval/tds-2026-10-26-metro-min docs/agent-eval/reports/tds-2026-10-26-metro-min.json`，179 个文件，命中 0。

**偏差与风险**：只跑了 1 次，不能说明这条约定稳定起作用。80 轮正好用到模板任务的轮数上限，06 这一例没有轮数余量；同一用例上次是 67 轮。

## Comments
