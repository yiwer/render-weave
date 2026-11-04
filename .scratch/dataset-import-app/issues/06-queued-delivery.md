# 06：恢复排队出图并在提交前拦截缺少的必填参数

**What to build:** 恢复本机 115 验收服务的同构建 worker，让已有批次完成处理；补齐出图侧栏的必填参数检查。

**Blocked by:** 无

**Status:** resolved

**Trace:** 用户报告“115-down-app/currentIndex=1 一直排队”；M378。

- [x] 用实际任务查明排队原因并恢复领取，保留原批次与错误记录。
- [x] 必填参数缺失在提交前提示，不向批次端点提交；按范围提供的参数与 false/0/空字符串缺省值不误报。
- [x] 验证真实服务构建一致、队列清空和同数据预览；记录原批次的实际结果。

**测试接缝：** 真实 PostgreSQL 队列和 worker 健康检查；浏览器经真实 HTTP API 操作出图侧栏。

## Answer

2026-11-04 完成。根因是本机验收运行期间重建了引擎，却未同步重启渲染 worker。旧 worker 构建为 `sha256:7bad90ffac1444b5f54219ca9582a5afe6d6dbc527a360c22a1c9fa8107c2080`；用户批次绑定磁盘新构建 `sha256:7ab928a58e7520f0d235152d3695837a32ff92763d403938702f8e0c455923fd`。队列按构建领取（`service/migrations/0006_records_and_replay.sql:23`），因此旧进程虽 ready 仍不领取此批次。

- `node out/dataset-115/check-queue.mjs` 修复前退出 1：批次 `4ed013f3-e346-43b6-b20c-ad848b27cf7b`，32 项 queued，已超过 60 秒。`node service/dist/main.js build-id` 与任务构建一致，排除了需要改写任务构建的做法。
- 重启渲染 worker 后立即领取，约 4 秒完成全部 32 项；再次执行同一检查退出 0，全部 done。随后 API 同步重启，健康检查的构建与 worker 一致；未改写历史批次，未重复提交或调用模型。
- 原批次最终 **32 项失败、0 交付**，每项都是缺少 `routeCaption`（线路标题）、`proofCaption`（试制说明）。本次用户设置为 400 × 130 mm、120 dpi、本站 1–32；没有将缺省尺寸解释为原制作表的尺寸，没有自动填写制作说明并重交。
- 为此补出图侧栏提交前检查，按展开后的参数检查必填项，并显示必填标记。服务端仍保留原有逐项校验合同。
- `RW_BROWSER=<Chrome> npx vitest run service/test/deliver-parameters.browser.test.ts --maxWorkers=1`：先红（缺参数仍有 1 次 POST），修复后 1/1 通过，验证缺参数 0 次提交、补齐后正常提交 3 项，范围值和 false/0/空字符串缺省值保留。
- `RW_BROWSER=<Chrome> npx vitest run service/test/console.browser.test.ts -t '登录后首页|主路径' --maxWorkers=1`：2 项通过，28 项按选择器跳过；覆盖参数预览与范围交付、单图和整批下载。
- `npm run typecheck:service`、`npm --prefix service run build` 通过；`node out/dataset-115/verify-recovery.mjs`：真实服务同构建、队列 0、原批次处理完成；同一第 1 项补测试用参数后的草稿预览 0 问题。没有新增正式批次。

本机诊断材料位于 `F:/GenCode/render-weave-dataset-import-app/out/dataset-115/`：`queue-check.json`、`user-batch.json`、`user-batch-snapshot.json`、`recovery-verification.json`、`recovery-preview.png`。诊断脚本仅保留在忽略目录，不打印会话令牌或密码。

下一步：用户刷新页面，填写线路标题与实际制作说明后重新提交；参考图新增字段/样式的批准仍按票据 05 的材料单独确认。
