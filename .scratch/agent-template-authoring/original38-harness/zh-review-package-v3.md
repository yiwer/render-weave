# 中文实际成果审核包：只读读取与独立对照图

本工具为原38的实际M402模板/修改成果制作人工审核材料，不改变模型输入、判据、预算或任何封存原件。新候选的两次模板、两次修改各生成独立包；旧包保留。

`prepare-review-v3.mjs` 经公开 `readReview(round,{persistArtifacts:false})` 与 `readPreviousRound` 取得已生效的完整候选及固定资源，再用公开 `loadWorkspace`、`render` 出图。原始轮次和复制轮次在读取前后均核对完整文件、目录集合及逐文件SHA；复制轮次也不写入检查/预览缓存。源实验、候选、绑定、唯一attempt与封存记录继续逐项核对。

实际请求仍按原轮次的50 DPI输出；另以相同有效候选生成120 DPI草稿供放大对照，独立保存其请求、问题和图片身份。两者不互相替代。`layout-inventory.json` 遍历实际请求的全部公开布局节点，包括所有重复实例；库存数量不自证文字、状态或视觉正确，布局框坐标也不含旋转影响。

首页只呈现原图、实际图、对照图及16类人工检查范围；诊断入口折叠，空白表保留审核者、时间、分钟、是否预看诊断和各项结论。没有自动批准、应用或填入人工评价。

模板修改页另在图片之前直接展示本轮封存修改要求全文、原文链接及 SHA，明确修改要求优先于原图和旧库存；不依赖汇总索引传达要求。Z10 按“地标为竖排最后一格，各列末格底齐”核对，Z12 按“道路名两端留白与字间距相同”核对，其他类别及两类中的非目标属性与修改前保持一致。16 项仍全部等待人工判断。原库存保存在 `source-scope.md`，修改审核库存另存 `scope.md`，两者都有来源身份。

修改前基准图以本轮固定 `snapshot` 和资源，经公开 `render` 使用同一 50 DPI 实际请求生成，另存 `before-revision.png` 与渲染记录；审核人据此核对非目标保持。它不是原图、实际修改成果或新增模型轮次。基准未出图时明确提示证据缺口。

## 修改要求展示补修验证（2026-10-26 UTC）

- 旧候选6首遍修改包的公开页面检查退出1：单页没有直接显示封存修改要求全文，保留旧包不覆盖。
- 修复后生成 `out/harness-original38-review/zh-revision-r1-candidate-6-v2/`，公开生成命令退出0；原轮及副本102文件、22目录完整路径集合和逐文件 SHA 均不变。
- `node check-revision-review-package.mjs <新包目录>` 退出0：单页显示封存要求全文、链接、SHA与优先级，Z10/Z12按本次要求核对，其他14项对照修改前；16项判断、总体接受和分钟仍为空。
- 修改前基准为1457×325、50 DPI，问题清单为空；实际修改成果仍1457×325、50 DPI，另存3496×780、120 DPI对照图。没有改动候选运行时或模型成果，没有新增模型调用。
- `node --check prepare-review-v3.mjs`、`git diff --check` 通过。此验证仅证明审核材料能表达已封存任务，不代表人工业务接受。

`zh-style-inventory-v2.md` 沿用现有16类样式/状态库存，仅据原图修正Z16的“括号内”描述：15个时刻由斜线分隔，原图没有围住全串时刻的括号。字体名称、字号毫米值和可接受视觉差异仍未独立核准，不生成新的自动真值或通过阈值。

## 已执行预演

2026-10-23，以候选4的公开入口读取旧候选3的一次已封存模板成果，显式使用 `--preflight`；这不是候选4真实模型观测或业务验收。产物在 `F:/GenCode/render-weave/out/harness-original38-review/zh-generator-candidate4-preflight-01/`：

- 原件及副本106文件、26目录，完整集合与字节不变。
- 5个有效模板；实际请求1457×325像素、50 DPI；独立对照图3496×780像素、120 DPI。
- 完整遍历296个布局节点、86个文字节点；`preflight=true`、`candidate=null`、`humanReview=null`。
- `node --check` 与实际生成退出0。首次尝试将scope置于整个out根，输出保护在建目录前拒绝；移入独立材料子目录后执行成功，未放宽保护规则。

## 实际调用

从候选4实际封存attempt取得每个轮次路径后使用：

```powershell
node .scratch/agent-template-authoring/original38-harness/prepare-review-v3.mjs --candidate F:/GenCode/render-weave/out/harness-acceptance-20/candidate-4 --runtime F:/GenCode/render-weave/out/harness-acceptance-20/candidate-4/content --evaluation F:/GenCode/render-weave/out/harness-original38-candidate-4/evaluation --binding F:/GenCode/render-weave/out/harness-acceptance-20/plans/original-four/binding-4 --round <本候选实际attempt/round> --out <此前不存在的新审核目录> --scope .scratch/agent-template-authoring/original38-harness/zh-style-inventory-v2.md
```

实际成果尚未封存时不得执行上述正式调用。独立人审结论和实测分钟另存，不以生成材料包关闭原34/38。
