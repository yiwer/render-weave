# 四组旧归档的37轮只读恢复复验

2026-10-23，四个既有归档分别恢复到全新目录，再由已独立复核的候选4公开读取37轮。**22,916个文件、5,268个目录在读取前后的完整集合及逐文件SHA均相同**；四份归档的完整集合及SHA也相同。原候选、业务结果、失败、旧恢复件及旧证明均保留。本次补足读取后完整集合不变的证据，不改变历史业务结论。

此前旧验证只遍历清单内文件，不能证明读取后没有新增缓存；详细更正见[恢复边界说明](archive-restore-boundary-correction.md)。新接口责任为票14的提交`8b6f3b3a04f2b1ac565369f0e3a3d9e03705454b`。本次只调用冻结包公开`dist/index.js`的`readReview(roundDir,{persistArtifacts:false})`，不调用私有审核或评分实现。

## 实际身份与边界

- Reader候选：`sha256:7ce9b838a00faa36038bb1c68e1d9e957380c23ead0d0abedf6dc0c1da449804`；包路径`F:/GenCode/render-weave/out/harness-acceptance-20/candidate-4`。
- candidate.json SHA：`ca3ec1630f13b57ea853148df7972334558225496e204c7b1b52a3db8775357d`；公开候选verify在恢复前后均exit 0。
- 实际Node为Windows x64 v24.12.0，二进制SHA为`2ffe3acc0458fdde999f50d11809bbe7c9b7ef204dcf17094e325d26ace101d8`。实际index/review/preview模块SHA、独立审查文件SHA与激活事实保存在[可复核摘要](archive-readonly-candidate4-evidence.json)及原始`reader-identity.json`。
- 只读检查0模型、0人工审核、0批准、0应用；不产生新的业务观测或成本结论。原始绝对路径未改写，仅证明本机新恢复件的公开只读查看，未验证任意机器接续。原38候选3另5轮由其责任人独立记录，不纳入37轮。
- 无有效预览缓存时，公开只读接口可内存渲染，返回尺寸、问题与assessment而省略image；不要求生成新预览文件。本次37轮均有view、无problems、已committed，verdict与各旧验证选定轮次一致。该技术verdict不代替独立业务审核。

## 实际结果

|既有归档|查看轮次|恢复文件|恢复目录|完整集合/SHA前后|归档前后|
|---|---:|---:|---:|---|---|
|18 v2|8|6,205|1,983|相等|相等|
|21候选2|16|6,986|1,590|相等|相等|
|21候选3|8|5,172|979|相等|相等|
|原38候选2|5|4,553|716|相等|相等|
|总计|37|22,916|5,268|无新增、缺失、改变|无新增、缺失、改变|

目录数按新恢复目录内完整枚举统计，包含归档的根标签目录；不与旧CLI摘要中不同根边界的目录数混用。读取前集合已与原archive manifest严格相等，之后比较全部文件/目录；封存摘要前又对当前新恢复件完整枚举及哈希复核一次，仍与after清单相同。原38共享plan后来追加的binding-3/binding-4不在旧archive里，未混入这次恢复集合。

## 公开执行与证据

运行命令exit 0：

~~~powershell
node out/harness-archive-readonly-revalidation-preparation/revalidate.mjs --activation C:/Users/Administrator/.codex/visualizations/2026/10/23/01a167fb-6fcb-7771-8713-7be4f73bddf8/harness-archive-readonly-candidate4-activation.json --out F:/GenCode/render-weave/out/harness-archive-readonly-revalidation-candidate-4
~~~

脚本按已固定plan选择原验证同一批8/16/8/5轮；从candidate4/content运行公开`freeze.ts --verify`和`archive-context-trial.ts --restore`，目标必须不存在。每组restore命令/输出、37个实际view、before/after及archive-before/archive-after清单均保存到新目录；没有通过删除缓存、重打包旧归档或改写原报告获得相等。

- 证据目录：[harness-archive-readonly-revalidation-candidate-4](F:/GenCode/render-weave/out/harness-archive-readonly-revalidation-candidate-4)。摘要逐一固定79份原始证据的路径、长度与SHA；详细清单保留在`evidence/<group>/`，恢复件在`restored/<group>/`。
- [入库摘要](archive-readonly-candidate4-evidence.json)与外部封存副本字节相同，SHA：`8c84af66fd1eeb3b37ee72daece4d2fb9d8542312b2f9c66703f915e004fe349`。源结果、plan、activation及runner的实际SHA均在其中。
- 旧四份归档manifest SHA保持25faa300…ffa8c、ce416f56…51a6、f4345789…95c9、0f7f43a8…122f；完整值与各组前后清单SHA见摘要。旧91缓存文件/55目录仍留在旧恢复件，本次不把旧验证追认成当时已通过完整集合检查。

票18只补这8轮的恢复边界，保留原比较结论；票21只补两个历史候选的24轮只读可查看性，其有效失败及未完成的真实门槛保持原结论。本次文档不关闭其他票，也不修改原38责任记录。
