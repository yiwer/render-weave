# 04：从已应用数据集准备通用渲染项并交付

**What to build:** 按明确的模板、参数和尺寸计划生成渲染项，可按任意列表位置展开，完整核对数据集范围，固定批次快照后复用既有交付与重放。

**Blocked by:** 03

**Status:** resolved

**Trace:** M367、M368；用户“继续推进下一步”；流程 P06。

- [x] 只接受已审核应用的数据集轮次，核对应用后的数据与定义；所有候选须出图或明确记录跳过理由。
- [x] 支持多个模板/尺寸组、对外参数、通用列表位置展开；不包含线路或站点字段分支，不按业务值去重。
- [x] 生成可检查的标准批次请求，固定模板、数据、资源版本及字节；准备、交付、草稿、失败与未执行分别记录。
- [x] 复用既有交付、记录读取和离线重放；拒绝证据变更、缺失和未完成准备目录，取消不冒充完成。
- [x] 通过公开 CLI/API 验证非公交多数据集和列表位置场景，输出实际图片、记录与说明；补审核页面走查或明确环境阻塞。

**测试接缝：** src/index.ts、src/cli.ts 的公开入口及正式出图记录；不测私有映射函数。

## Answer

2026-11-03。独立工作树 F:/GenCode/render-weave-excel-prototype，分支 feature/excel-agent-p06，基线 a05b5db99d4f43f7359f02d3679af0b018213ada；主检出只同步文档。

- src/agent/output-plan.ts 提供 prepareAgentOutput / deliverAgentOutput；src/cli.ts 增加 agent prepare-output / agent deliver-output，bin 在项间处理取消。复用现有批次快照、交付、记录和重放，不引入业务字段分支。
- 计划完整分类本轮应用候选，支持模板/尺寸分组和显式列表位置展开；列表跳过不重编号，重复业务值不去重。准备核对当前数据及定义与已审核内容一致，固定全部依赖后交付；交付再次核对范围、候选和定义，即使文件哈希同时被改写也不能替换已审核数据或漏项。
- npm run build、npm run typecheck：通过。
- node node_modules/vitest/vitest.mjs run test/agent-output.test.ts test/agent-excel.test.ts --maxWorkers=1 --no-file-parallelism --reporter=json --outputFile=out/excel-p06/tests.json：26/26 通过，其中新增出图 13 项、Excel 审核 13 项。
- node node_modules/vitest/vitest.mjs run test/cli.test.ts test/output-records.test.ts test/batch-cancel.test.ts --maxWorkers=1 --no-file-parallelism --reporter=json --outputFile=out/excel-p06/regression.json：58/58 通过。
- 首轮新增测试为 10 通过、1 失败：目录模板的横排 fit 只写 shrink，违反 M84；补齐 compressGlyphs 后 11/11 通过，再增加伪造哈希/遗漏范围与布局失败两项。未放宽引擎规则。
- node scripts/accept-excel-output.mjs --out out/excel-p06/accept-01：价签 6/6、嵌套目录 5/5 正式交付，均 0 严重问题、0 提示；分别保留 1 条明确跳过记录。目录参数是 1、2、4、5、6；两个首项独立重放，图片字节一致。已查看价签首项和目录末项的 PNG，货号前导零、价格和目录位置正确。
- 此次端到端复用 P04/P05 模型产物，无新增模型调用；脚本先与独立真值核对，再仅对新建的仓库夹具轮次自动审核应用。旧待审产物保持原状态，不将自动测试记成人工客户核准。
- 证据子集在 docs/agent-eval/excel-output-p06/，完整运行（含字体、全部记录）在 out/excel-p06/accept-01/；SOURCE 身份见 provenance.json。git diff --check 通过。
- node scripts/scan-keys.mjs docs/agent-eval/excel-output-p06 out/excel-p06：扫描 256 个文件，检查 1 个 key，命中 0。

成果说明：[操作流程](../../../docs/excel-agent-output.md)、[实测与证据](../../../docs/agent-eval/excel-agent-p06.md)。

偏差与后续：本机 Computer Use 报原生管道不存在，浏览器宿主也不可用，审核页面交互走查没有完成；公开 HTTP/API 行为保留既有验证。P07 需实际制作表、人工核准真值、业务全流程工时/成本；统一工作簿 agent run、检查点和生产隔离仍待收口。当前交付不支持通配符/跨表关联，交付强退不自动续跑，保留已完成子批次供读取并使用新目录重跑。
