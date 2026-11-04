# P05 嵌套 staticSchema 真实模型证据

`nested-01/` 保存一次 Claude Code + OpenCode Go 会话，目标 `catalog@1`，包含两层对象列表和三份引用定义。实际项目说明、原件、定义固定在 `inputs/`；原始提示词、工具调用、流式事件保留在 `logs/`。

`attempt-01/` 保留空单元格 H4 导致的真实脚本失败，`attempt-02/` 保留模型修复后的代码、完整候选和独立检查；没有故障注入。`oracle.json` 是对模型不可见真值的离线比对，`provenance.json` 保存模型调用时的源码哈希，不代表调用后审核链路加固的最终源码。模型配置缓存、临时管道配置和进程 PID 不归档。此目录在 .gitattributes 中禁止换行转换，保留实际证据字节；不要统一格式化归档。host-tests.json 是最终 13 项公开入口测试报告。

报告见[实测说明](../../../../docs/agent-eval/excel-agent-p05.md)。复跑会调用模型并计入套餐额度，使用新目录：

```powershell
node --import tsx scripts/prototypes/excel-agent/agent-run.ts --workspace fixtures/workspaces/excel-catalog --definition catalog@1 --workbook fixtures/excel/price-tags.xlsx --brief scripts/prototypes/excel-agent/evidence-p05/nested-01/inputs/brief.md --out out/excel-p05-new-run --claude '<本机 claude.exe 的路径>'
```

只复核并导入现有证据（不调用模型、不执行候选脚本）：

```powershell
node dist/bin.js agent import-excel --from scripts/prototypes/excel-agent/evidence-p05/nested-01 --workspace fixtures/workspaces/excel-catalog --out out/excel-p05-recheck
node dist/bin.js agent review out/excel-p05-recheck
```

如需应用，先复制工作空间再导入，避免改写夹具。机械通过始终仍待业务审核。
