# 05：用用户提供的实际制作表运行一次 CodingAgent

**What to build:** 使用用户指定的 930898314428416.xlsx 原件，实际运行 Claude Code + OpenCode Go，独立核对提取结果并记录成功范围与阻塞原因。

**Blocked by:** 04

**Status:** resolved

**Trace:** 用户“使用 D:\我的桌面\我的下载\930898314428416.xlsx 尝试”；P07 实表探索，不等同完整业务验收。

- [x] 固定原件哈希、测试工作空间 staticSchema、项目说明和真实模型运行证据。
- [x] 按原件独立核对方向、站点顺序、逐站时间、编码、尺寸及空值，保留特殊文字。
- [x] 报告检查结果、模型用量、耗时及未覆盖内容；只有达到原有审核门槛才继续正式导入。

**测试接缝：** 现有 agent-run.ts、本地正式 CLI；不改动引擎或删除原件部件使测试通过。

## Answer

2026-11-03（本地日期；运行开始 UTC 2026-11-04T02:38:28.131Z）。本票完成一次实际尝试，不代表整表成功、完整 P07 验收或业务核准。实现基线 476c96a，记录分支 feature/excel-agent-p07。解释见 [实表报告](../../../docs/agent-eval/excel-agent-p07-115.md)。

- 原件 24858 字节，SHA-256 `469774248cc9055307c5430c6282417ba179e11000bc0e2e92531c8661a357e0`。未修改原件；本地完整证据在 `out/excel-p07/930898314428416/`，核对页 `review.html`，原模型候选 `run-01/attempt-01/candidate.json`。
- 本次调用者建立独立测试工作空间 `production-direction@1` 引用 `production-stop@1`，保留原表信息；不是已有正式公交模板。宿主通过公开 `publishStaticSchema` 生成并固定定义；模型不能修改定义。试跑脚本初次相对导入路径错误已修正，不属于模型转换失败。
- `npm run build` 通过；`python -X utf8 scripts/prototypes/excel-agent/prototype.py read <原件> --out <inspection/view.json>` 成功，发现批注/VML 未读取及 27 个数字显示格式告警。
- `node --import tsx scripts/prototypes/excel-agent/agent-run.ts --workspace out/excel-p07/930898314428416/workspace --definition production-direction@1 --workbook <原件> --brief out/excel-p07/930898314428416/brief.md --out out/excel-p07/930898314428416/run-01 --claude <本机 claude.exe>` 实际调用 OpenCode Go / claude-haiku-5-5 / Claude Code 2.1.296。10 个模型轮次、1 次转换、83894 ms；无故障注入。容器 977 ms，正常退出且清理确认。
- 2 份候选、32+32 站，411 个非空源单元格全部分类；引擎全部通过、0 问题。机械检查唯一错误 `unreadWorkbookParts`，未读取 `xl/comments1.xml`、`xl/drawings/`、`xl/drawings/vmlDrawing1.vml`；因此 `passed:false`，没有 submission.json。
- 独立 `verify_source.py freeze` / `compare` 直接读取原件 OOXML，不导入产品读取器、不执行模型计划或脚本。完整正文数据逐值、类型、顺序、可选空值一致，0 差异；包含尾随空格、原括号和多行备注。独立核对脚本初次报告路径绝对/相对混用已修正。原表另有 10 条批注，不在候选内，不能将正文一致称为整表成功。
- 正式 `agent import-excel` 对未完成包拒绝导入，当前错误是 `ENOENT ... submission.json`；没有创建审核目录、没有应用、没有出图。该用户提示待票据 06 一起改善，不伪造提交标记。
- 输入 12、输出 17733（其中 thinking 13544）、缓存读取 118945、缓存创建 62915 tokens；实际套餐扣费未知，未采集真人业务审核时间。
- `node scripts/scan-keys.mjs out/excel-p07/930898314428416`：44 文件、1 key、0 命中。源表/批注/模型全量日志仅保存在被忽略的 out 目录；仓库只保存报告和不含原始数据的汇总证据。

下一步：票据 06 补全通用批注来源及 VML 判别，使用未修改的同一原件重跑；经人工核准后再做出图和工时验收。
