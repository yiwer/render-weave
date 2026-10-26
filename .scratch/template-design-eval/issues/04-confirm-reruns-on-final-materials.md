# 04: 01、11、12 在现行材料下各重跑一次，确认基线后的修改

**What to build:** 首轮基线之后改过 01 的项目说明（站名最长 8 字）与 `order-label`、`hazmat-label` 约定包（删掉"换行""两行""多行段落"与按分号拆行的建议），这三个用例要在现行材料下各跑一次，确认修改没有引入新的失败。

**Blocked by:** 03

**Status:** resolved

**Trace:** [父规格](../spec.md)；M337；验收 A5。

- [x] 额度窗口恢复后运行（约 3 轮，各 7–15 分钟）：

  ```bash
  npm run build
  npx tsx scripts/agent-eval/run.ts --config scripts/agent-eval/template-design/config.json --repeat 1 --label tds-baseline-1c --scenarios tds-01-m518,tds-11-hazmat,tds-12-cup-label
  ```

- [x] 没达线的逐项复核（规则同票据 03）：草稿与样图一致却没过的改检查，模板缺陷保留；结果记进 `docs/agent-eval.md`「模板设计评估集」的表格。
- [x] 若 11 仍把安全措施拆成固定几行，说明约定第 11 条没起作用，再看是否要在项目说明里写明分条数不定。
- [x] 跑完用 `node scripts/scan-keys.mjs out/agent-eval/tds-baseline-1c` 确认产物里没有 key。

**测试接缝：** 只调评分时用 `--rescore`，不再调用模型。

## Answer

2026-10-26 完成。没有单独跑 `tds-baseline-1c`：评估集已 cherry-pick 进 main（92583af），用户要求在 main 的 Agent 上给 Haiku 5.5 与 DeepSeek V4.1 Flash 各跑全集，其中 Haiku 那一组（`tds-main-haiku-5-5`）用的就是现行材料，覆盖了本票的三个用例。

- 01：达线，压测 10/10（含"8 字站名"）、版面 15/15，17.8 分钟。
- 11：达线，压测 8/8（含"安全措施 60 字"）、版面 15/15，8.2 分钟；安全措施放在一行里压缩、缩字，没有再按分号拆行，约定第 11 条起了作用。
- 12：达线，压测 9/9、版面 13/13，16.5 分钟。
- `node scripts/scan-keys.mjs out/agent-eval/tds-main-haiku-5-5 docs/agent-eval/reports/tds-main-haiku-5-5.json`：2419 个文件，命中 0。

**偏差**：这次同时换了 Agent（main 的执行、检查点与预算机制，合同 0.17.0），不是只改材料的孤立对照；结论只能说现行材料加 main 的 Agent 下这三例都达线。

## Comments
