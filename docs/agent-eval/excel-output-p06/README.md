# P06 证据索引

- `tests.json`：出图接续与 Excel 正式审核的公开入口测试。
- `regression.json`：既有 CLI、出图记录与取消测试。
- `acceptance.json`：两个受控夹具的完整 CLI 准备/交付及独立重放汇总。
- `provenance.json`：执行时的源码、构建产物和引擎构建身份。
- `price-tags/`、`catalog/`：实际 CLI 参数及输出、准备清单、交付汇总与示例 PNG。

此处是说明与证据子集，未包含字体资源或所有批次快照。完整运行在 `out/excel-p06/accept-01/`；用 `scripts/accept-excel-output.mjs --out <新目录>` 重新生成。自动审核仅用于已核对独立真值的仓库夹具，不是客户批准。
