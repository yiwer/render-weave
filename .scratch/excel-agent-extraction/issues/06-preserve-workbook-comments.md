# 06：让业务批注进入 Excel 提取与独立审核

**What to build:** 在通用工作簿视图、任务工具、映射、独立检查及正式审核中保留单元格批注，区分批注容器 VML 与其他未支持绘图，再用票据 05 的原件重跑。

**Blocked by:** 05

**Status:** resolved

**Trace:** M365、M366；用户要求读取器、映射、独立检查和审核展示支持批注，并处理 VML 锚点后以同一原件重跑；P07 / A01 / A04。

- [x] 批注保留工作表、单元格、原文及源部件身份，支持富文本拼接、换行、空格；审阅页能够定位原件。
- [x] 通用映射能读取批注或明确记录未映射理由，独立检查重读原件并核对，模型不能伪造已读取或随意忽略批注。
- [x] VML 中只包含匹配批注锚点时明确记录覆盖范围；非批注图形、图片、异常关系与未知部件仍阻止完成，不允许简单移除 unreadParts 检查。
- [x] 用公开导入入口覆盖批注篡改、来源错位、漏批注、非法 XML/关系和既有无批注工作簿；未完成提取包返回可理解的失败原因，不只报 submission.json 不存在。
- [x] 用原件 SHA-256 469774248cc9055307c5430c6282417ba179e11000bc0e2e92531c8661a357e0 再跑真实 Claude，保持 64 个站点正文一致，并逐条核对 10 条批注；旧失败证据保留。

**测试接缝：** 工作簿读取 CLI、通用映射检查 CLI、正式 agent import-excel / review 公开入口；新增合成批注夹具，用户原件仍留在本地 out 中。

无模型渠道或渲染引擎修改。先明确通用批注字段/来源合同，再执行；不把安装位置、地铁线号等业务词写进通用代码。不以自动核准替代用户对制作规则及尺寸单位的确认。

## Answer

2026-11-03。本地工作树 `F:/GenCode/render-weave-excel-prototype`，实现分支 `feature/excel-agent-comments`，基线 `ffa81cb`。实现说明、使用入口和原件复跑解释见[报告](../../../docs/agent-eval/excel-agent-comments.md)。

- `agent/excel/workbook.py` 解析传统批注关系及纯 Note VML，保存作者、原文、部件、图形身份、零基目标行列和显示框；空单元格/空批注不丢失，目录 ZIP 条目不冒充未读绘图。XML 限制同样覆盖 VML，非 Note / 图片 / 控件 / 未知部件仍阻止完成。
- `generic_check.py` 增加 `comment` 与 `commentContext`，正文分类与批注分类分离，逐原文、字段路径、坐标和部件独立核对；漏批注与伪造来源失败。提取运行器与正式导入共用该宿主实现，历史原型证据未覆盖。
- `excel-import.ts` 从重新读取的原件构建批注审核证据；未完成包先报告失败原因。`excel-evidence.ts` 的修正重放包含来源部件比较。`web/review.html` 展示批注、VML、字段定位与未映射理由，Excel 页面使用全宽表格，来源文字始终通过文本节点写入。
- `npm run build`、`npm run typecheck` 均通过。
- `node node_modules/vitest/vitest.mjs run test/agent-excel-comments.test.ts test/agent-excel.test.ts test/agent-output.test.ts test/agent-review.test.ts --maxWorkers=1 --no-file-parallelism --reporter=json --outputFile=out/excel-p07/930898314428416/comments-01/tests.json`：61/61 通过。补充 `Visible=false` 用例及处理后，单独复跑批注文件写入 `comment-tests-final.json`：23/23 通过；两批共覆盖 62 个不同用例，不将重复运行计作新增用例。
- 真实运行：`node --import tsx scripts/prototypes/excel-agent/agent-run.ts --workspace out/excel-p07/930898314428416/comments-01/workspace --definition production-direction@2 --workbook <同一原件> --brief out/excel-p07/930898314428416/comments-01/brief.md --out out/excel-p07/930898314428416/comments-01/run-01 --claude <本机 claude.exe>`。1 次会话、11 个模型轮次、1 次转换、无故障注入，109273 ms；容器 946 ms、清理确认。机械及引擎通过，411/411 非空单元格、10/10 批注全部分类并实际映射。
- 对照模型不可访问的独立 OOXML 基准：两个方向各 32 站与 10 条批注完全一致，包含换行、作者前缀、尾随空格与终点可选空值，0 差异；另直接解析原件 VML，10/10 锚点的目标、显示框、图形身份与可见性一致。最终读取器重读的完整 view 与模型输入相同，哈希 `88df76a94c0585a16c85652486f6dcbd51dda62ac511d9f1cad8ee069a07f0f7`。
- 正式 `agent import-excel` 生成 `comments-01/review-01` 的两份待审候选；没有代替业务批准、应用或出图。旧 `run-01` 失败证据及原 Excel 保持原样。
- 本机 Chrome 无界面浏览器加载正式审核服务：10 条批注逐字、源部件、VML 与字段路径全部匹配；定位链接实际抵达目标行，1600/800px 无横向溢出、无脚本错误；已查看截图。审核状态 inProgress、canApprove=false。测试服务与浏览器已关闭，另保留只读 `review.html` 和 `review-comments-clean.png`。
- 用量：输入 12、输出 24011（thinking 17480）、缓存读取 165669、缓存创建 75613 tokens。人工业务审核工时、实际套餐扣费均未知，不从自动检查时间或标价估算。
- `node scripts/scan-keys.mjs out/excel-p07/930898314428416/comments-01 docs/agent-eval/excel-comments-115`：94 文件、1 key、0 命中。完整原件/候选/日志/截图留在本地 out，仓库只归档汇总、哈希及不含用户原文的测试报告。

范围：支持传统批注与纯 Note VML，不承诺线程批注、任意绘图或完整 Excel 格式兼容。浏览器是自动化展示核验，不是人工业务审核。下一步由业务核准制作规则、尺寸单位与模板后进行正式出图及工时/成本验收。
