# Excel 提取、审核、修正与应用

本地链路以工作空间已发布的 staticSchema 为目标，支持多份候选和嵌套对象列表。模型执行沿用 Claude Code + OpenCode Go；完成的提取包通过正式 `agent import-excel` 重新核验，再进入既有 `agent review` / `agent apply`。实现位于分支 `feature/excel-agent-p05`，工作树 `F:\GenCode\render-weave-excel-prototype`；主检出仅同步文档。

`agent run` 的工作簿输入尚未统一；目前提取使用原型入口，审核与应用使用正式入口。完整流程设计见[流程文档](excel-agent-workflow.md)，本轮证据见[测试报告](agent-eval/excel-agent-p05.md)。

## 1. 提取

在上述工作树根目录准备 Node 依赖并运行 `npm run build`。提取需要 Claude Code、`OPEN_CODE_API_KEY`、Python 3.13 和 Docker Linux 引擎，固定镜像的准备方法见[原型说明](../scripts/prototypes/excel-agent/README.md)。仅导入、审核和应用不调用模型或 Docker，但独立核验仍需要 Python。

先复制示例工作空间，以免应用覆盖夹具。以下命令使用新输出目录；已存在时换名字，不删除旧证据。

```powershell
New-Item -ItemType Directory -Force out | Out-Null
Copy-Item -Recurse fixtures/workspaces/price-tag out/my-price-workspace
node --import tsx scripts/prototypes/excel-agent/agent-run.ts --workspace out/my-price-workspace --definition '商品价签@1' --workbook fixtures/excel/price-tags.xlsx --brief scripts/prototypes/excel-agent/fixtures/price-brief.md --out out/my-extraction --claude '<本机 claude.exe 的路径>'
```

实际业务替换工作簿、项目说明和 `--definition`。字段取自所选发布版本，说明中写明对象范围、行列含义、缺省规则与未映射内容的处理；不需要在代码中增加线路或商品专用分支。

## 2. 固定为正式审核轮次

```powershell
node dist/bin.js agent import-excel --from out/my-extraction --workspace out/my-price-workspace --out out/my-review-01
node dist/bin.js agent review out/my-review-01
```

导入重读原始 xlsx，按映射独立重算来源和全部候选，并逐份调用引擎校验。它不执行提取包里的 `transform.py`，也不信任包中的“检查通过”标记。工作空间定义与提取时不一致就拒绝导入；需要重新提取。

可加 `--python '<Python 路径>'`。`--resources` 指定本地资源仓库并固定副本，供引擎校验；它不会从 Excel 图片或任意 URL 自动生成资源。源表格式和转换支持范围仍以[映射合同](../scripts/prototypes/excel-agent/CONTRACT.md)为准。

审核页提供：固定原件下载、数据集字段到工作表/单元格的映射、排除区域及理由、每份完整候选、修正重放及冲突。

逐份核对表头含义、映射、顺序、单位和缺省规则。选择“改值”时编辑整份数据集 JSON，并填写修改原因；保留 `dataset` 身份，只修改 `data`。保存后立即重新检查类型和约束。所有候选均需处理，不能只删除其中一份后应用；缩小范围应重新提取。确认剩余内容并核准后才能应用。

## 3. 重跑并保留人工修正

调整项目说明或映射后重新提取，使用新的提取目录，再导入：

```powershell
node dist/bin.js agent import-excel --from out/my-extraction-02 --workspace out/my-price-workspace --out out/my-review-02 --previous out/my-review-01
node dist/bin.js agent review out/my-review-02
```

修正记录包含字段路径、原候选值、新值或删除、修改原因和本地审核主体。仅当原件哈希、定义、数据集身份、唯一源单元格及原候选值都匹配时自动重放；嵌套列表位置改变时按源单元格重新定位。连续重放仍保留最初原因。

不匹配时保留新提取值并列出冲突，需明确采纳新值或再次人工改值。上一轮未处理的冲突不能通过再导入一轮消失。新轮次始终重新审核，不继承批准；已经应用的旧轮次不作为修正重放来源。当前不支持跨不同原件自动迁移修正。

## 4. 完整应用

```powershell
node dist/bin.js agent apply out/my-review-02
```

应用保存完整候选集合，记录既有提交回执；重复执行返回同一结果。应用前再次核对原件、映射、定义、候选和审核身份。提交中断后由公开读取/应用入口恢复；证据被修改则保留冲突，不能跳过恢复检查。

数据应用不等于出图。后续按模板选择和参数准备渲染请求，再走既有出图、交付入口。P06 接续这部分，不能把本阶段的通过扩大为完整业务替代。
