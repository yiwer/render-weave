# 01: 评估命令能换配置跑，模板场景可逐例组资源、按数据驱动的压测与版面检查评分

**What to build:** `run.ts --config` 选评估配置；模板场景可写 `resources` 在单元目录里组资源仓库、写 `scoring` 用 `stress.json` 与 `checks.json` 评分；M402 场景的评分不变。

**Blocked by:** 无

**Status:** resolved

**Trace:** [父规格](../spec.md)；M333、M334、M335；验收 A1、A3、A4。

- [x] `run.ts --config <文件>`：评估清单记下配置，`--rescore` 与续跑沿用；同一个 `--label` 换配置时报用法错误；续跑命令带上 `--config`。
- [x] 场景可写 `resources: {from, images}`：单元目录下组 `resources/`，字体取配置的共用仓库（硬链接，不行再复制），图片只放列出的；列出的图片不在素材清单里时报错。没写时用共用仓库。
- [x] 模板场景可写 `scoring: {stress, checks}`：`scoreTemplateCase` 按示例请求出草稿，压测改数据（路径键、`null` 删除、`$take` 循环取项）、参数与尺寸；版面检查支持 `text`、`image`、`barcode`、`qrcode`、`largest`，可限区域、字号、颜色，`absent`、`variant`。
- [x] 报告与判定：版面检查的项数记在 `layoutTotal`，未达线原因逐项列出未过的检查与差在哪里；M402 的 `landmarkBaseline`、`roadAlign` 照旧，相似度仍按 437 × 98。
- [x] 离线测试：改数据与检查的单元用例；05 专家模板正例与空画板反例；假执行器跑通 05 并重新评分。

**测试接缝：** `test/agent-eval-template-design.test.ts`；评分入口 `scoreTemplateCase`、`evaluateCheck`、`patchData`，编排入口 `runScenario`、`scenarioResources`。

## Answer

2026-10-25 完成。

- 代码：`scripts/agent-eval/scenarios.ts`（`resources`、`scoring`、`TEMPLATE_DESIGN_CONFIG`）、`score.ts`（`scoreTemplateCase`、`evaluateCheck`、`patchData`；`TemplateScore` 加 `checks`、`layoutTotal`，M215 两项改为可选）、`eval.ts`（`scenarioResources`、按 `scoring` 分支评分、判定与摘要用 `layoutTotal`）、`run.ts`（`--config`）。
- 中途改过一处：起初示例图与检查按约 800 像素宽的 DPI 出草稿、压测缺省 30 DPI，05 的专家模板因此每项都报 `barcode.sizeInvalid`（CODE128 每模块至少 2 px）。改为示例图与检查按示例请求的 DPI，压测缺省也取它，大尺寸的牌子在 `stress.json` 写 30。
- `npx vitest run test/agent-eval-template-design.test.ts`：8 项全过，约 12 秒。05 专家模板压测 8/8、版面 11/11、示例草稿 0 个问题；空画板压测 8/8、版面 0/11（压测本身拦不住空模板，靠版面检查）。
- 门槛场景：`scripts/agent-eval/config.json` 未改；`test/agent-eval.test.ts` 的 M402 校准数字不变（全量测试结果见票据 02）。

## Comments
