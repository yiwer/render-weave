# 候选6原四第二次366：请求40 / 返回47的轮数口径

已验证：47等于46条原生user事件加初始1；按message.id归并后的19个模型响应中，18个含工具调用。此观测不支持“超过40次工具循环”的判断，也没有触发或证明40上限硬截断。

- 唯一数据集尝试：`43605172-bb73-483a-8969-d55ba85a5084`，封存目录：`F:/GenCode/render-weave/out/harness-original38-candidate-6/evaluation/run-2/366-transcription/attempts/43605172-bb73-483a-8969-d55ba85a5084`。
- 原始字段：round.runtime.maxTurns=40；原生result.num_turns=47、subtype=success、stop_reason=end_turn、is_error=false；round.run.turns与报告attempt.usage.turns原样为47。原生result在stream第109行，逐行SHA见同名JSON。
- stream共109条事件：system1、assistant61、user46、result1。assistant按message.id归并为19组，18组带工具、1组为最终回答。共有45个不同tool_use及45个对应tool_result，另1条user为第28行isSynthetic=true的图片坐标提示；因此成功计数为45+1+1=47。MCP调用33与报告口径相符，全部工具数45不等同循环次数。
- 固定CLI2.1.296，exe SHA256 `76de74f7694a5bdc03378a5f837c9e132827bf004c98c276bc4e9094ff06769a`。重新读取同一二进制的短片段：228987648初始化Ot，228987870附近每条user递增Ot；228996440普通成功结果写num_turns:Ot。228989150附近另取max_turns_reached的turnCount，228995993上限错误使用Lt.turnCount；228850348附近工具循环guard传递独立turnCount:tr。完整短片段及SHA在JSON，不复制无关二进制内容。
- 候选源码run.ts:493将maxTurns传为--max-turns，usage.ts:18原样记录result.num_turns。既有[40/43核对](../../.scratch/agent-template-authoring/original38-harness/candidate-2-turn-count-review.md)为同exe SHA的历史参照，不替代本次原始流。
- [Claude官方Agent循环说明](https://code.claude.com/docs/en/agent-sdk/agent-loop)当前说明同一响应可拆多条assistant事件、maxTurns只计含工具的循环；本次安装版本另有固定二进制与封存流支撑。

本次只读核对18项通过；原report/round/stream/封存记录及所读代码的SHA前后相同，新增模型与运行器调用均0。这里只核计数含义，不改变预算或业务评分；上限截断仍须单独受控验收，本次不追加该实验。
