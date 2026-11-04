# 同一 115 原件的应用内导入与模板接续

2026-11-04，M376。已通过真实页面上传 `930898314428416.xlsx`，由独立 Agent worker 调用 Claude Haiku 5.5 + OpenCode Go，保存到 PostgreSQL/S3，再用兼容模板预览。验收状态与命令见 [票据 04](../../.scratch/dataset-import-app/issues/04-live-workbook-115.md)，机器摘要见 [报告](reports/2026-11-04-dataset-import-115-app.json)。

## 查看本地现场

- 应用：`http://127.0.0.1:18080/console/`。
- 任务：`#/dataset-imports/f10f692b-254b-452b-8e8b-49c676fc28f0`。
- 已保存数据集：`115-down-app`、`115-up-app`，静态数据定义为 `production-direction@2`。
- 登录信息只在本机 `F:/GenCode/render-weave-dataset-import-app/.secrets/dataset-115-login.json`，没有进版本库。页面用普通客户管理员身份，不提供免登录入口。
- 原件、模型材料、独立核对、审核截图和预览保留在 `F:/GenCode/render-weave-dataset-import-app/out/dataset-115/`。主要文件：`verification.json`、`browser-review.json`、`browser-applied.json`、`review.png`、`review-narrow.png`、`dataset-preview.png`、`preview.png`；`archive/extraction/` 是原始模型证据，`applied-round/` 是最终审核材料。

本地服务使用独立 Compose 项目 `rw-dataset-import-115` 的 PostgreSQL/S3（仅本机端口 25474/29074），API、Agent worker 和渲染 worker 直接运行构建产物。其他项目的容器、旧原件工作空间和已交付图片均未覆盖。服务关掉后可在本次工作树恢复：

```powershell
Set-Location F:\GenCode\render-weave-dataset-import-app
docker compose -p rw-dataset-import-115 -f compose.yaml -f out/dataset-115/compose-host.yaml up -d --wait postgres s3
node out/dataset-115/host-service.mjs api
# 另外两个终端分别运行（Agent 终端仍需 OPEN_CODE_API_KEY）：
node out/dataset-115/host-service.mjs worker
node out/dataset-115/host-service.mjs agent-worker
```

这些本机启动脚本只在忽略目录中读取私有配置，不是生产部署包。不要重新运行 `prepare.mjs` 或删除数据卷；数据库已经保存此次任务和数据集。重新上传会产生新模型调用。

## 实际处理链路

1. 原件 SHA-256 `469774248cc9055307c5430c6282417ba179e11000bc0e2e92531c8661a357e0`，与前轮完全相同。浏览器选择 `production-direction@2`，提交原件和原有批注提取要求，新增数据集 ID 避免覆盖旧结果。
2. 真实工具循环 153,890 ms，11 个模型轮次、3 次转换尝试。前两次遇到容器/附着进程超时，第三次执行并通过独立检查。没有人为注入缺陷；不能据此宣称修复了模型业务算法错误。原始轮次完整保留。
3. 独立程序直接解析 OOXML，未导入产品读取器或执行模型脚本；模型未得到核对基准。两方向各 32 站、411 个非空单元格、10 条批注及 10 个 VML 锚点一致；候选业务字段也与此前用户已批准的数据逐字一致。
4. 浏览器逐候选核对 64 个站名输入值与 10 条批注原文，展开 VML 显示位置。1600px 和 800px 页面无横向溢出、无脚本异常；API 重启后任务与原件仍可查看。
5. 沿用此前批准范围，在独立验收租户点击确认整组保存。没有新增业务解释，没有把自动化走查记成新的人工审核。
6. 打开 `115-up-app`，选 `production-115`，填本站序号 13、线路标题 115、制作尺寸说明 `52.5*13.5 cm`，设置 525 × 135 mm、120 DPI。真实渲染 worker 返回预览，32 个站名、本站宪丰村、下一站与源数据一致，问题清单为空。

这里使用的是此前已批准的简洁模板。用户参考图对应的 `production-direction-view@1` 显示投影与新模板仍单独待审，没有套用本次批准。此轮只验证数据模块接续模板预览，没有重复生成 65 张正式交付。

## 走查中修正

- 工作表、候选切换与模板选择框补明确的可访问名称；浏览器可以按标签准确定位并切换。
- 上传页此前写死 16 MiB，但服务端默认只允许 5 MiB。`GET /v1/agent-jobs` 现在返回有效 `maxWorkbookBytes`，页面按此展示、在上传前拒绝超限文件；后端同时限量，并受正式审核包 16 MiB 上限约束。OpenAPI 升至 1.11.0，旧标准表格批量出图不变。
- 修复 Docker 容器已删除后附着进程仍挂起的回收遗漏：等待退出超时后结束本轮附着进程，即使 `created=false`，最终清理也会回收它。容器创建/检查的时间与脚本执行预算分开，模型总预算不变。故障接缝验证、原脚本重放和真实无限循环超时验证均另存记录，未改写原模型证据。

模型记录：input 24、output 23542、thinking 11185、cache read 393399、cache creation 73605 tokens。人工业务审核工时与实际扣费未知。此次为宿主进程加容器存储的本地走查，完整镜像部署和生产隔离验收仍未通过。
