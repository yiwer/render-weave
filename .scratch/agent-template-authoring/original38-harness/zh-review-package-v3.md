# 中文实际成果审核包：只读读取与独立对照图

本工具为原38的实际M402模板/修改成果制作人工审核材料，不改变模型输入、判据、预算或任何封存原件。新候选的两次模板、两次修改各生成独立包；旧包保留。

`prepare-review-v3.mjs` 经公开 `readReview(round,{persistArtifacts:false})` 与 `readPreviousRound` 取得已生效的完整候选及固定资源，再用公开 `loadWorkspace`、`render` 出图。原始轮次和复制轮次在读取前后均核对完整文件、目录集合及逐文件SHA；复制轮次也不写入检查/预览缓存。源实验、候选、绑定、唯一attempt与封存记录继续逐项核对。

实际请求仍按原轮次的50 DPI输出；另以相同有效候选生成120 DPI草稿供放大对照，独立保存其请求、问题和图片身份。两者不互相替代。`layout-inventory.json` 遍历实际请求的全部公开布局节点，包括所有重复实例；库存数量不自证文字、状态或视觉正确，布局框坐标也不含旋转影响。

首页只呈现原图、实际图、对照图及16类人工检查范围；诊断入口折叠，空白表保留审核者、时间、分钟、是否预看诊断和各项结论。没有自动批准、应用或填入人工评价。

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
