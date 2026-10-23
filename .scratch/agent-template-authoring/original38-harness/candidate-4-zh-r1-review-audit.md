# 候选4中文第1次模板/修改：审核材料独立核验

结论：两份材料包的来源、封存字节、分辨率及空白人审记录均核验通过，可作为独立人工审核材料。**这不是业务验收通过：模板公开日志为压测9/10，2站有严重问题，未达线；修改公开日志为达线，但独立人审尚未进行。**

核验时间：2026-10-23 20:35:59 UTC。只读文件系统，未调用产品、模型或人审入口，未改活动目录、封存原件、候选、包内材料。

共同身份：候选sha256:7ce9b838a00faa36038bb1c68e1d9e957380c23ead0d0abedf6dc0c1da449804；原四绑定sha256:c95dfdb1e4c3154cfb85fe981c528246d115fb6b80480adc1c05de33581e85d0；实验sha256:c6eccead1b20d245dc2369dd1a2853f87f5445f201a0811f75a1aeaf08a257c9。两包均为preflight=false，使用已独审v3生成器f4154b41939a836b826d92e2d90fe07d4e50e239b8480f30c3e3196909584de1。

| 项目 | 模板第1次 | 修改第1次 |
|---|---|---|
| 材料目录 | F:/GenCode/render-weave/out/harness-original38-review/zh-template-r1-candidate-4 | F:/GenCode/render-weave/out/harness-original38-review/zh-revision-r1-candidate-4 |
| 唯一attempt | 83349334-f839-44e5-8f4e-feaeadc95f92 | 8f5573d7-ca66-42d3-818b-fb3d32414d31 |
| manifest SHA256 | 67157c7dd590625629c3b9eb7c960c102d999fe40cd778760df2507fdaa75b19 | 5df9698dc408ae8248bdeb6c7eed8e13fbe70804b361af5669cf9b59a8d09082 |
| 源轮次/目录 | 93文件/22目录 | 102文件/22目录 |
| 封存attempt文件 | 95 | 104 |
| 包内清单文件（另加manifest） | 112 | 118 |
| 有效候选模板 | 5 | 2 |
| 完整布局节点/文字节点 | 312/72 | 354/73 |
| 独立断言 | 573项通过 | 600项通过 |

两包的candidate/binding/eval、started、completion seal、完整封存文件集合与SHA均一致；原轮次及round-copy的完整文件、目录集合和每文件SHA相同。有效候选与源JSON语义相同，源参考图SHA为583f591b5f08c631162ebac188bcd7ecc999af40cf077d161d05cfdd0a6d75e6。公开审核contentIdentity、实际请求、固定资源所在封存字节均保留。原生轮次记录为Claude Code2.1.296、响应claude-haiku-5-5；本次只核包来源，不重做整段来源/用量审计。

实际图均为原请求的final模式、50DPI、1457×325；比较图均由同一有效候选另行公开render为draft模式、120DPI、3496×780。PNG实际尺寸与图片SHA已核对，不能把高分辨率比较草稿当正式请求通过。

每包16项人审表全部为空；审核者、开始/结束时间、activeMinutes、是否先看诊断、原始判断、业务接受和各项位置/证据/意见均为null。未填写人工结论或分钟，后续r2两包尚不在本次范围。

业务事实来自原四首段公开stderr第3/4行，核验时完整段报告仍待完成：

- M402 模板 第 1 次：未达线（压测 9/10，要求至少 10（有严重问题：2 站））。
- M402 模板辅助修改 第 1 次：达线。

逐项证据是本目录harness-zh-template-r1-candidate4-package-audit.json和harness-zh-revision-r1-candidate4-package-audit.json。此文和两份JSON固定保留，不回写原件或将包装核验计入模型观测。
