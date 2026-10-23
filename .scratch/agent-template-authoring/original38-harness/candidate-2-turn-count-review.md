# 原38的40/43轮数差异：只读核对

判断：此观测的43来自Claude原生结果消息计数，与请求的40次工具循环上限不是同一口径；目前没有超40次API循环的证据。本次没有实际触发40上限，因此也不据此宣称硬轮数截断已证明。

原件：`F:/GenCode/render-weave/out/harness-original38-candidate-2/evaluation/run-1/366-transcription/attempts/f1120c25-edfb-483b-8e27-01220e6b726a/round/`。只读元数据与二进制片段见同目录外部文件 `harness-native-turn-count-readonly.json`，未修改原件。

- 宿主 `runtime.maxTurns=40`；`src/agent/run.ts:491` 将该值传为 `--max-turns`。`src/agent/usage.ts:18` 原样记录原生 `result.num_turns`，没有自行加轮。
- 该原始stream共有54条assistant事件，按实际message.id归并后为15个模型响应：14个响应含工具调用，1个最终文字回答。41个工具调用会各自产生结果；流中共有42条user事件。末尾是 `success`、`end_turn`、`num_turns=43`。
- 固定原生二进制 `claude.exe` 2.1.296（SHA256 `76de74f7694a5bdc03378a5f837c9e132827bf004c98c276bc4e9094ff06769a`）包含可读执行代码：字节偏移228987648将结果计数Ot初始化为1，228987920在每条user事件递增Ot；228996262附近的success结果将num_turns设为Ot。因此本次43恰好对应42条user事件加初始1。
- 同一二进制在228989222读取独立的 `max_turns_reached` 附件及其turnCount；228850387附近由工具循环的guard turnCount决定是否返回该附件。错误结果使用该附件的turnCount，普通成功结果使用前述Ot。这两条路径的计数不是同一变量。
- [Claude官方Agent循环说明](https://code.claude.com/docs/en/agent-sdk/agent-loop) 说明一个API响应可拆成多条assistant消息，maxTurns只计带工具的循环；这与本次按message.id归并所得14个工具响应一致。网页是当前说明，安装版本的判断另由固定二进制和原始流支持。

核对没有调用模型、读取密钥值或修改预算/评分；只执行原生 `--help`、读取固定二进制和封存日志。后续如需证明上限截断，须另用明确受控的原生循环验收；不扩展本次资料顺序修复。
