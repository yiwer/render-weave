# 115 显示字段审核与参考图模板接续

2026-11-04，M377。新增显示字段已走通真实网页上传、Claude + OpenCode Go 提取、独立来源核对和正式审核。用户确认前保留为候选；旧数据、旧模板和旧交付不变。验收命令与状态见 [票据 05](../../.scratch/dataset-import-app/issues/05-display-mapping-review.md)。

## 现场入口

- [参考图与 65 张样张总览](http://127.0.0.1:18115/)：第 13 站对照、四类尺寸筛选、全部原始批注与待确认差异。
- [应用内数据审核](http://127.0.0.1:18080/console/#/dataset-imports/61f625af-c1e4-4033-977e-e447c634e7d7)：`production-direction-view@1` 的两份候选，来源区域逐项展示映射规则。
- 本机登录信息仍在 `F:/GenCode/render-weave-dataset-import-app/.secrets/dataset-115-login.json`，不进版本库。
- 成果根目录：`F:/GenCode/render-weave-dataset-import-app/out/display-115/`。`latest.json`、`verification.json`、`browser-review.json`、`mapping.png`、`comparison.png` 为数据和网页核对；`archive/extraction/` 保留完整模型原始证据；`workspace/`、`resources/`、`preview/` 为可重现样张的输入及输出。

总览关闭后，在该工作树运行 `node out/display-115/serve.mjs`；应用恢复步骤沿用 [上一轮现场](dataset-import-115-app.md)。不要重复运行上传脚本，新任务会产生模型调用。

## 显式映射如何审核

通用计划 `split.values` 在工作空间任务中声明原文到显示值的对照。检查器从原件重算，不执行模型脚本；未知拆分项报 `unmappedValue`，不删除、不猜默认值。空白输出空列表，保留顺序与重复项。对照支持 JSON 标量、对象及列表，最多 200 项、8 层，并计入原有求值预算。

来源新增 `mapping: {separators, values}`，必须与计划一致。网页和本地审核页均展示规则；人工修正重放还需规则完全一致，否则保留冲突。映射的业务含义仍由人确认。实现没有“115”“地铁”或其他领域特判，操作合同见 [CONTRACT.md](../../agent/excel/CONTRACT.md)。

本次候选对照：1/2/3/4 → 对应地铁线，火车站 → railway，机场 → airport。原件实际只有 22 个类别：地铁 1 号 2 个、3 号 14 个、4 号 4 个、火车站 2 个；没有凭空补 2 号线或机场站点。64 条原站点记录去掉新增 `connections` 后，与独立 OOXML 真值逐字段一致，10 条批注和 10 个 VML 锚点一致。两份数据集 ID 为 `115-down-display-review`、`115-up-display-review`。

## 模板样张与正式交付边界

使用前轮 `preview-03` 的四个模板候选，包含已留证的 450 mm 线路号右对齐修正；原模型轮次、候选和用户原图没有改写。当前正式提取候选直接作为渲染输入，65 张样张重新生成；2080 个站名、本站/下一站状态、首末班、站码、尺寸及 715 个换乘标记核对通过。图片问题清单为空，原图像素还原仍未评分。

待确认的是新增换乘解释，以及近似设施图标、副名 5 mm、图例比例与四种尺寸版式。此前批准不自动扩展到这些内容（M373）。确认后才能应用新版数据和模板、生成正式记录；本轮不会把草稿 PNG 改名充当正式交付。

出图范围沿用 65 项：45 × 20.8 cm 18 项、52.5 × 13.5 cm 44 项、48 × 13.5 cm 2 项、89 × 27 cm 1 项，96 dpi PNG。两个缺尺寸终点继续明确排除，站名和批注仍完整保留。

## 本轮运行记录

新增 1 次真实模型运行，Tool Runner + Claude Haiku 5.5 + OpenCode Go，259,456 ms、16 轮、2 次转换。首次执行返回 timeout，记录中还包含找不到 candidate.json 的错误；第二次完成并通过检查。两次都确认清理，没有注入故障，不将该重试宣称为业务算法修复。

模型上报 input 34、output 49590、thinking 20949、cache read 854832、cache creation 103096 tokens。人工业务审核工时与实际扣费未知；生产部署和隔离验收不在本轮完成范围内。
