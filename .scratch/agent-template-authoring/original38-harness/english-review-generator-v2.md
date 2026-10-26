# TfL161 唯一纠偏审核包生成器

v2 保留旧生成器及首次包原字节，新增真实首次与唯一接续的审核关系。它不运行模型、不批准或应用成果，不填写人工结论与分钟。

## 来源与边界

- `--registration` 的单元只接受 `original38-en-tfl161/design-1` 或 `correction-1`。纠偏强制 `--first-package`；首次禁止带入该参数。
- 首次包的完整文件、目录和 SHA 必须符合其固定 `manifest.json`，来源证明必须和清单一致；首次原轮次完整集合符合 `source-proof.json`，并匹配纠偏登记的首轮记录 SHA。
- 纠偏公共阶段绑定须使用相同冻结候选，`--from` 指向真实首次，绑定材料包含首次来源证明的 SHA。实际纠偏须直接接续该轮的 outcome、未审核状态及参考，不能用检查点或改基替代。
- 仅从公开 `dist/index.js` 的 `readReview(...,{persistArtifacts:false})`、`readPreviousRound`、`loadWorkspace`、`render` 读取和渲染普通副本。原轮次、首次轮次、首次包、核准材料的完整路径集合与 SHA 在前后比对；拒绝链接、覆盖和来源内部输出。
- 首页提供原样整页、原图页首、首次原始成果与当前原始请求成果。三者按同画板宽度展示；图片不重画、不重采样。39 项区域表分别呈现首次及纠偏窗口；所有人工判断与分钟为空。自动结果和模型说明只在独立诊断页。
- `independent-review.json.firstOutcome` 引用首次固定包中的实际身份；`correctedOutcome` 引用当前真实接续。首次清单、来源证明及原始成果图逐字节复制，新包写明它们的原目录与 SHA。

## 已完成离线预检

执行 `node --check` 与公开 `--verify-inputs`：首次、纠偏两条预检成功；7 个拒绝边界全部命中（缺首次包、首次混入前包、候选不符、首次记录 SHA 不符、预检读本轮、来源内输出、覆盖已有目录）。59 份核准材料、119 份首次包文件、93 份首次原轮次文件及各完整目录集合前后相同。

证明：[verification.json](F:/GenCode/render-weave/out/harness-english-review-generator-v2-preflight/verification.json)，SHA `1ed076f47a06cd09e2f3761b160d1fae88e0c0b63fbc34719dd12ff68e8222f5`；源脚本 SHA `470421baf63319c429bf4c188361b7fe1e9691eccf86698b7405818a4f2185b0`。该预检没有读取纠偏轮次，没有生成实际包。负例目录只是输入拒绝用 fixture，不是 attempt 或模型成果。

## 实际生成

必须先完成独立工具审查，并由唯一派发者确认该轮 `dispatch.json` 已封存。此命令本身不会派发模型：

```powershell
& 'D:/nodejs/node.exe' '.scratch/agent-template-authoring/original38-harness/prepare-english-tfl161-review-v2.mjs' --registration 'F:/GenCode/render-weave/out/harness-original38-english-tfl161-correction-candidate-5/registration.json' --first-package 'F:/GenCode/render-weave/out/harness-original38-review/en-tfl161-design1-candidate-5' --round 'F:/GenCode/render-weave/out/harness-original38-english-tfl161-observations-candidate-5/correction-1' --out 'F:/GenCode/render-weave/out/harness-original38-review/en-tfl161-correction1-candidate-5'
```

实际产物及人工审核仍须另行核查；本工具预检通过不表示纠偏效果通过，也不关闭原 38 或总验收。
