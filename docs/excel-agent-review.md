# Excel 提取、审核、修正与应用

本地链路以工作空间已发布的 staticSchema 为目标，支持多份候选和嵌套对象列表。模型执行沿用 Claude Code + OpenCode Go；完成的提取包通过正式 `agent import-excel` 重新核验，再进入既有 `agent review` / `agent apply`。后续出图也已接入，批注接入实现位于分支 `feature/excel-agent-comments`，工作树 `F:\GenCode\render-weave-excel-prototype`；主检出仅同步文档。

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

传统批注作为独立来源：查看“批注原文与来源”，逐条核对工作表、单元格、原文、作者、源部件、VML 锚点和目标字段。字段来源中的“某格 批注”链接可跳转到原文。批注可能附在空单元格；读取正文不等于已读取批注。`commentContext` 单独记录未映射批注及理由，审核采纳仍需确认这些理由。

目标定义需要保留批注时，为相应对象发布文本字段，用 `comment` 节点映射；不要让模型改动已固定 staticSchema。保留作者文字前缀、换行和空格；没有批注时省略可选字段，原批注存在但文字为空时保留空字符串。映射和脚本来源格式见[合同](../scripts/prototypes/excel-agent/CONTRACT.md)。

VML 的零基 Row/Column 用来核对批注所属单元格，Anchor 八项表示显示框位置。只有全部 Note 图形与批注一一对应时，才把该 VML 记为已覆盖；未知绘图、控件、图片、线程批注和异常关系继续阻止完成。原件没有 VML 时可读取传统批注原文，页面明确没有显示框。实际制作表复跑见[批注报告](agent-eval/excel-agent-comments.md)。

未完成的提取包不能导入。CLI 会提示查看 `result.json` 和尝试检查报告，并列出已有机械错误代码；不要创建假的 `submission.json` 来绕过该门槛。

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

数据应用后，按[出图接续说明](excel-agent-output.md)使用 `agent prepare-output` 固定模板、参数、渲染项和资源，再由 `agent deliver-output` 交付。准备、正式交付、预览、失败和未执行分别记录。完整业务替代仍需实际制作表验收。
