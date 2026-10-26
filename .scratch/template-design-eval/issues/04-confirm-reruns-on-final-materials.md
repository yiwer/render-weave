# 04: 01、11、12 在现行材料下各重跑一次，确认基线后的修改

**What to build:** 首轮基线之后改过 01 的项目说明（站名最长 8 字）与 `order-label`、`hazmat-label` 约定包（删掉"换行""两行""多行段落"与按分号拆行的建议），这三个用例要在现行材料下各跑一次，确认修改没有引入新的失败。

**Blocked by:** 03

**Status:** ready-for-agent

**Trace:** [父规格](../spec.md)；M337；验收 A5。

- [ ] 额度窗口恢复后运行（约 3 轮，各 7–15 分钟）：

  ```bash
  npm run build
  npx tsx scripts/agent-eval/run.ts --config scripts/agent-eval/template-design/config.json --repeat 1 --label tds-baseline-1c --scenarios tds-01-m518,tds-11-hazmat,tds-12-cup-label
  ```

- [ ] 没达线的逐项复核（规则同票据 03）：草稿与样图一致却没过的改检查，模板缺陷保留；结果记进 `docs/agent-eval.md`「模板设计评估集」的表格。
- [ ] 若 11 仍把安全措施拆成固定几行，说明约定第 11 条没起作用，再看是否要在项目说明里写明分条数不定。
- [ ] 跑完用 `node scripts/scan-keys.mjs out/agent-eval/tds-baseline-1c` 确认产物里没有 key。

**测试接缝：** 只调评分时用 `--rescore`，不再调用模型。

## Comments
