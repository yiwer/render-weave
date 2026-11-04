# 数据集智能导入的应用接入

规格与代码证据见[接入方案](../../docs/excel-agent-app-integration.md)，决定 M374–M378。

| 票据 | 直接阻塞 | 验收映射 |
|---|---|---|
| [01：合并实现并核对应用接入](issues/01-merge-and-assess.md) | 无 | 保留两侧历史与主检出文件；回归；代码接缝与实施顺序 |
| [02：按静态数据定义创建数据集](issues/02-create-by-static-schema.md) | 01 | 方案第 1 项；无模板创建与已有路径兼容 |
| [03：工作簿智能导入、来源审核和整组保存页面](issues/03-smart-import-module.md) | 02 | 方案第 2–4 项的内部模块；后台任务、整组保存、具体页面及真实小样 |
| [04：启用应用并走查同一 115 原件](issues/04-live-workbook-115.md) | 03 | 真实 PostgreSQL/S3 与模型；原件独立核对；网页保存与模板预览 |
| [05：显示字段进入可重放审核](issues/05-display-mapping-review.md) | 04 | 显式映射、来源展示、修正冲突与参考图模板样张 |
| [06：恢复排队出图并拦截缺失参数](issues/06-queued-delivery.md) | 无 | 本机进程构建一致；提交前必填检查；真实队列与预览 |

规格见 [spec.md](spec.md)，实际合同与尚待验证的生产边界见 [模块说明](../../docs/dataset-import.md)。
