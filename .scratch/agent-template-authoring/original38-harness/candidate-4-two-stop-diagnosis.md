# 候选4原四第一遍：M402两站压测失败诊断

**结论：这是模型模板对小站数的尺寸适配缺陷。保留本次9/10失败，继续已登记的第二遍；没有依据改评分器、降低阈值或新增候选。** 冻结候选的公开 `render` 在完整外部副本上复现了同一严重问题，未发现输入漂移或引擎违反公开尺寸合同。模板辅助修改的PASS是另一个场景，不能抵消本项失败。

诊断时间：2026-10-23 UTC，详细时间见同名JSON。只读取已封存 `83349334-f839-44e5-8f4e-feaeadc95f92`；不读取第二遍模型过程或留出结果。零模型、零批准/应用、零源模板及阈值修改；未调用 `readReview`。

## 证据与病因

- 候选：`F:/GenCode/render-weave/out/harness-acceptance-20/candidate-4`，ID `sha256:7ce9b838a00faa36038bb1c68e1d9e957380c23ead0d0abedf6dc0c1da449804`，manifest SHA `ca3ec1630f13b57ea853148df7972334558225496e204c7b1b52a3db8775357d`。包内 `freeze.ts --verify <candidate-4> --current` exit 0；公开入口模块SHA `133b260ebe1f5d1ab95c7279ee822f7ed6325bbc9e30be99094198f9ea870fa4`。
- 冻结业务配置 `F:/GenCode/render-weave/out/harness-acceptance-20/plans/original-four/config.json:19` 的模板场景要求10项压测全部通过（`:38`）。绑定 `binding-4/binding.json` 内容ID、配置字节、15资源字节、eval身份、attempt实验及预登记单元均核对一致。封存snapshot的5份工作区文件与冻结输入逐文件相同。
- 封存brief `F:/GenCode/render-weave/out/harness-original38-candidate-4/evaluation/run-1/m402-template/attempts/83349334-f839-44e5-8f4e-feaeadc95f92/round/agent/docs/brief.md:6` 明确宽740–1500mm、站数2–50。两站属于任务范围。
- 冻结 `content/scripts/agent-eval/score.ts:387` 使用原数据前两站，`:393`–`:398` 以740×165mm、30DPI、currentIndex=1公开渲染并计severe。第一站“建设路总站”，第二站“建设路”保留 `badges:["地铁"]`；数据见封存 `round/snapshot/dataset-m402.json:26`–`:27`。
- 封存主模板 `round/candidates/route-sign-main.json:381`–`:405`：站点循环left=21、width=fill、每项等宽。因此740mm画板的719mm可用宽分为两列，各359.5mm。
- `round/candidates/stop-column.json:133`–`:148`：父列居中，内部标识循环却设width=fill，纵向循环heights=content。第二站的标识调用框于是359.5×6mm。`round/candidates/stop-badge.json:9`–`:19` 自己声明宽2–60mm、高2–20mm；内部图像固定6×6mm（`:25`–`:32`）。
- 原样渲染返回唯一severe：`render.sizeOutOfRange`，路径 `线路牌主模板/站点循环[2]/列/站点标识[1]`，实际359.5×6mm，超出宽2–60mm。这是调用框宽度越界，不是图标资源损坏或字号问题。

所有上文 `round/` 相对位置均基于同一个封存attempt，完整绝对路径及SHA在同名JSON和 `harness-original38-candidate4-two-stop-diagnosis/source-before.json` 中。

## 判据和工具为何没有错

冻结公开参考 `F:/GenCode/render-weave/out/harness-acceptance-20/candidate-4/content/agent/reference/template.md:25` 规定被调模板实际尺寸来自调用框且必须落在sizeRange；`:116`–`:118` 规定纵向循环每项宽度填满区域，heights=content仅决定高度，`size:"hug"`不把此显式填满宽度改为6mm。实现 `content/src/evaluate.ts:132`–`:146` 与该合同一致；`content/src/layout/index.ts:255`–`:259` 正确对实际调用框报尺寸越界。未发现评分器或渲染工具把合法尺寸误判为失败的证据。

模型实际做过两站预览，但输入丢掉了标识字段：封存 `round/logs/tools.jsonl:12`、`round/logs/stream.jsonl:70`。这次自建两站资料只有name/road、currentIndex=0；工具明确返回两个外层“站点列”宽359.5mm超其当时max60的错误。最终成果把外层max改为1500，却仍保留内层标识max60。由于那份自建输入没有badges，内层调用没有发生；这是覆盖组合遗漏，不是工具吞掉已调用节点的错误。

已有指令足够明确，不应把本次遗漏改称资料或产品缺陷：冻结 `content/agent/guide.md:39` 要求被调模板范围覆盖最少/最多项，`:47`–`:55` 要求交付前检查最少项、最多项、边界尺寸并允许内联数据；`content/agent/tasks/template-design.md:24` 再次要求按通用做法验证极端情况。模型读过真实数据集（`round/logs/tools.jsonl:6`），但其最少项探针没有保留该数据中的可选标识组合。

最终 `check.json` 的qualified对应封存35站请求；其content仍needsReview，visual仍notChecked/referenceUnavailable。该结果没有声明10项业务压测或人工视觉已通过，不能拿它覆盖9/10。

## 公开复现与单变量探针

先创建外部普通目录副本，核95个封存文件SHA及completion seal；原件完整97文件/23目录与副本逐字节、完整集合一致。所有渲染经候选4 `dist/index.js` 的公开 `readPreviousRound`、`loadWorkspace`、`render`，没有调用私有评分函数。结束再次核原件与副本完整集合/SHA均无变。

| 探针 | 结果 |
|---|---|
| 未修改模板，准确重放冻结10项业务输入 | 9/10，只有两站的标识调用框越界 |
| 同两站输入，仅DPI由30换50 | 同一严重问题，排除DPI差异 |
| 同两站输入，仅清空第二站badges（诊断对照） | 0严重，确认触发在可选标识分支；不能作为验收替代 |
| 同两站输入，仅在进程内存将标识循环width从fill换fixed6 | 0严重，确认调用框宽度因果；未修改副本或原件 |
| 原模板，前11站 / 前12站，740mm | 11站宽65.364mm失败；12站宽59.917mm通过，与60mm上界一致 |

初始红例命令 `D:/nodejs/node.exe <external>/harness-original38-candidate4-two-stop-diagnose.mjs` exit 1（预期红）；后续 `harness-original38-candidate4-two-stop-probes.mjs` exit 0。共17次离线公开渲染；原10项评分保持9/10，外部fixed6不计正式纠偏/业务通过。命令脚本、请求、完整问题、布局、PNG、实际工具文字反馈及源清单都已保存，具体索引见同名JSON。

## 最小建议与边界

当前由原38 owner保留自然失败并完成第二遍，后续按既定方案汇总，不自动重冻候选。若另行授权模板纠偏，最小方向是约束标识调用框至合理图标宽并保持其在站点列内对齐；用最少站数且保留真实可选标识的合法数据验证，再覆盖既定宽度/站数范围。不要扩大判据容忍度或删掉有标识的输入来过关。

本诊断只确认该severe的病因。fixed6尚未作为正式纠偏验收；整体视觉质量、人工逐项判断和分钟仍未知。第二遍结果不在本快照范围内。
