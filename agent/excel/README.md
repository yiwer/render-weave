# Excel 导入的宿主校验

`src/agent/excel-import.ts` 通过 Python 3.13 标准库运行 `verify.py`。此目录属于宿主运行时，不是提供给模型的工具或生成代码。

- `workbook.py` 从固定 xlsx 重建坐标、原值、显示状态、传统批注与未读内容；提供 `read --input source.xlsx --out view.json` 和 `region --input view.json --sheet sheet-1 --range A1:C3 --out region.json` 只读 CLI。
- `generic_check.py` 按 `rw-excel-plan/2` 独立重算全部候选和来源，不判断业务字段映射是否合理。
- `verify.py` 只读原件、目标、映射和候选，生成新的视图与检查结果；从不导入或执行 `transform.py`。

读取器和映射检查器从本仓库 P01–P04 原型提升，不复用旧系统源码。历史原型文件保留，新 `agent-run.ts` 与正式导入均使用此目录的读取器/检查器，避免两套批注规则漂移；历史证据按其基线提交复现。正式检查器限制总来源/分类引用数为 200000。其他上限包括原件 16 MiB、解压总量 32 MiB、100000 个实际单元格、每表 10000 条批注、200 KB 映射、20000 个映射求值节点、24 层递归，以及宿主 30 秒超时。Python 子进程仅获得系统运行必需的环境变量，不继承模型凭据。

传统批注经工作表关系解析，记录原文、作者、单元格和源部件。存在 VML 时只接受纯 Note 容器并将零基 Row/Column 与批注一一核对，Anchor 八项另存显示框位置；图片、控件、未知节点/部件、外部关系、重复或缺失锚点不能通过。XML/DTD 检查同样覆盖 `.vml`。没有 VML 的传统批注可保留原文，但不声称有显示框；线程批注、图片及任意 VML 图形不在支持范围内。

格式依据：[Microsoft LegacyDrawing](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.spreadsheet.legacydrawing?view=openxml-3.0.1)、[Microsoft OOXML Primer 第 6.5.2 节](https://download.microsoft.com/download/e/1/4/e14fb96f-83b8-4a2a-84db-7fa8acbe061a/Office%20Open%20XML%20Part%203%20-%20Primer.pdf)。实际支持子集以本地读取器和公开入口测试为准。

格式和转换子集见[映射合同](CONTRACT.md)。显示类别通过 `split.values` 显式对照，来源携带规则，未知原文失败；业务规则只写入工作空间任务，不放进通用检查器。部署正式 CLI 时须连同本目录及 `web/` 发布；仅复制 `dist/` 不足以运行审核功能。尚未承诺完整 Excel 兼容或共享生产环境隔离。
