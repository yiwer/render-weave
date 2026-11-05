# 08：把合并后的数据集模块部署到当前本地应用

**What to build:** 以固定构建升级当前 115 验收应用，保留历史数据，实测通用命名静态版本的导入审核保存和现有数据出图。

**Blocked by:** 07

**Status:** resolved

**Trace:** 用户要求“继续完成这个需求，这个需求是否已经落地”；M387。

- [x] 备份旧测试库，升级迁移编号，业务记录哈希保持一致。
- [x] API、渲染 worker、Agent worker 使用同一固定源码与构建；页面可登录、入口启用。
- [x] 非公交、命名静态版本的真实模型导入在页面可审核并保存；批注及 VML 保留。
- [x] 既有 115 数据仍可读、预览与验收批次出图完成；新增样式审核不自动应用。
- [x] 记录可操作入口、重启方法、验收证据及生产边界。

**测试接缝：** 本地真实 PostgreSQL/S3、Claude/OpenCode Go、浏览器及正式出图接口；验收材料使用合成数据。

## Answer

2026-11-04 完成（本机 America/Los_Angeles；原始日志 UTC 为 11-05）。部署源码固定为 `31575c76dfb4c5cf0a2ed8ccd40dd50a467aa0ad`，运行目录 `F:/GenCode/render-weave-runtime-31575c7/`。本票只补部署、应用内工作副本和验收材料，没有修改产品源码。操作入口与接续方法见 [本机运行说明](../../../docs/agent-eval/dataset-import-rollout.md)。

### 升级与保留历史

- 在独立运行工作树执行 `npm ci`、`npm ci --prefix service`、`npm run build`、`npm run build --prefix service`，全部通过。API/渲染 worker/Agent worker 构建均为 `sha256:23f276fe9f3d820a64a3825f391535906185425a4483c3c769891db516981857`。
- `node out/rollout/state.mjs before` 确认活动 Agent/渲染任务均为 0 后停止旧服务。`docker exec rw-dataset-import-115-postgres-1 pg_dump -U renderweave -d renderweave -Fc -f /tmp/before-31575c7.dump`，随后复制到本机；`pg_restore --list` 返回 292 行。备份 129745 字节，哈希及恢复边界见运行说明。未进行实际恢复演练。
- `node out/rollout/migrate.mjs` 执行已入库的守卫编号转换脚本；`node out/rollout/host-service.mjs setup` 补命名版本迁移 15，当前 schemaVersion 为 16。
- `node out/rollout/state.mjs after`：10 张业务表的排序整行哈希全部与 before 一致，包括 2 个原 Agent 任务、32 个历史批次项、20 份工作区文档。该比对发生在新增验收材料之前，不代表当前表总数。
- 新运行目录分别启动 `host-service.mjs worker / agent-worker / api`。最后 `node out/rollout/status.mjs`：API 1.12.0、enabled=true、API/worker 构建一致，活动 Agent=0、渲染=0；三个服务进程存活。原旧版运行目录没有重建。

### 通用定义的真实导入闭环

合成“物料卡”独立租户，静态定义 `material-card-rollout@release-2026-11`，明确覆盖非公交及命名版本；并非线路定义换名。字段为 label、note、emptyNote。定义经公开 API 保存并发布，模板经网页发布。

- `python out/rollout/source-truth.py`：从原件 OOXML 独立抽取真值。材料有 2 条传统批注、2 个 VML 锚点，含空批注、换行和字面 `<script>` 文本。
- `node out/rollout/upload-browser.mjs`：实际浏览器上传，实际 Claude Haiku 5.5 + OpenCode Go、Tool Runner 运行，任务 `643accf9-8065-4e6c-ba14-a5e18a388536`。排队 886 ms，创建到待核对 29109 ms；1 次转换通过独立检查，没有使用确定性模型替身。
- `node out/rollout/review-deliver-browser.mjs`：核对 3 个字段来源、原批注与 VML，在网页将 label 修改为“甲（功能验收）”，填写“合成资料验收：验证人工修正与原因留存”并保存审核。整组保存得到 `rollout-material-card`，精确命名版本及原 note 不变。此脚本之后在初版验收模板预览失败，后续按下面的文字合同诊断修正。
- `node out/rollout/fix-demo-layout.mjs`：最小公开预览复现单行“甲”无问题、`甲\n乙` 报 U+000A。确认 DSL 原合同文字元素只排一行（`docs/dsl/template.md`，M339），不是导入删改换行或字体缺中文。验收模板针对已断言的固定两行拆成两个文字元素，发布修订 3；原始 note 不变，并断言布局两行恰好等于原文拆行。没有扩大为任意段落排版能力，也没有修改引擎。
- `node out/rollout/finish-deliver-browser.mjs`：网页预览、批次提交、状态展示与 PNG 下载通过；图片已实际查看，预览 problems=[]，pageErrors=[]。同一已保存数据因为验收脚本续跑产生两个成功单项批次：`174f6348-46cd-494e-b7a6-282057fbc2c5`、`7cde47d7-f238-4f63-9f79-6e89e08628bb`，各 delivered=1、failed=0；只调用一次模型，不隐去重复验收批次。
- 模型上报 input=14、output=3100、cacheRead=35224、cacheCreation=10388 tokens；不能把 token 数当实际账单。

### 115 已有数据与模板制作

- `node out/rollout/inspect-115.mjs` 发现原显示字段任务已在部署前于 `2026-11-04T10:37:30.282Z` 进入 applied，两份 `115-*-display-review` 已存在。迁移前后记录哈希相同；这不是本轮代替用户做了新的业务确认。修正文档仍称其“待保存”的过时表述，历史审核包保留。
- `node out/rollout/verify-115.mjs`：原 `115-down-app/currentIndex=1`、正式模板 `production-115` 预览 0 问题；32 个站名与原件独立真值一致。验收批次 `99834217-8ea0-4ca8-a2ac-09402cfce07b`，delivered=1、failed=0，网页完成与下载通过，pageErrors=[]。画面带“本地模块验收 · 非制作交付”，不计作客户生产交付。历史失败批次保留，没有改写或自动重投 32 项。
- `node out/rollout/stage-115-design.mjs`：把原有四个参考图模板候选放入应用工作副本，上传缺失的 3 个 SVG 和 2 个字体资源；已有资源逐字节核对，不覆盖不同内容的资源/草稿。原两个正式模板的名称、修订、基准保持不变。四种业务尺寸及上行第 13 站共 5 次工作副本预览均 problems=[]，设计页面选择样例数据并显示画布，pageErrors=[]，实际看图核对。
- 四个模板仍未发布，参考图正式批次为 0；按 M373 等待样式业务确认，不把本轮预览计成新样式批准。

### 证据与边界

- 可入库摘要：[机器回执](../../../docs/agent-eval/reports/2026-11-04-dataset-import-rollout.json)、[参考图预览](../../../docs/images/dataset-import/rollout-reference.png)。完整脚本、截图、原件、数据库备份及登录资料留在本机 `out/rollout/` 和 `.secrets/`，不进仓库。前后迁移哈希在 before.json/after.json，真实导入在 acceptance.json，115 在 115-acceptance.json，工作副本在 reference-staged.json，最终运行状态在 final-status.json。
- 本轮只运行上述构建与实际服务/浏览器验收，没有宣称重新跑过全量引擎测试。合并代码的回归结果和既有全量 Agent 超时边界仍见票据 07。
- 自动审批拒绝过一个组合启停运维脚本，未给出更具体原因，脚本未执行；未换工具绕过，改为现有服务加手动重启说明及只读状态脚本。
- 本地应用需求已落地；生产托管、隔离复核与模型渠道门槛仍未完成。人工业务审核工时、实际扣费未知。
