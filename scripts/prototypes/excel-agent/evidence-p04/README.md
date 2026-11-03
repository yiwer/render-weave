# P04 首轮真实模型证据

`live-01/` 是 2026-11-03 在 `商品价签@1` 工作空间完成的一次 Claude Code + OpenCode Go 会话。结论与限制见[测试报告](../../../../docs/agent-eval/excel-agent-p04.md)。

- `start.json`、`provenance.json`：模型、执行器、输入与源码身份。
- `inputs/`：固定原件、视图、工作空间定义快照与项目说明。
- `logs/prompt.md`、`logs/stream.jsonl`、`logs/tools.jsonl`：实际提供给模型的内容、全部事件与工具尝试。未提供独立期望文件。
- `attempt-01/`：模型原脚本、追加测试缺陷后的实际脚本、失败产物与独立检查。
- `attempt-02/`：模型重新提交的脚本、通过的候选与检查。
- `submission.json`：模型原始说明与待确认事项，含报告指出的自由文本不准确处；保留原样。
- `result.json`、`oracle.json`：轮次结果与模型不可见的独立期望比对。
- `p01-p03-regression.json`：接入后的旧原型回归结果。

全部是仓库人工构造的公开样例数据。复制归档时排除 Claude 配置缓存、临时管道配置和进程 PID；这些文件不是业务证据。密钥扫描已执行，数值见票据。

真实复跑命令在[原型说明](../README.md)。仅重放最终转换（不调用模型）可从仓库根运行：

```powershell
python -X utf8 scripts/prototypes/excel-agent/prototype.py run --view scripts/prototypes/excel-agent/evidence-p04/live-01/inputs/view.json --plan scripts/prototypes/excel-agent/evidence-p04/live-01/attempt-02/plan.json --script scripts/prototypes/excel-agent/evidence-p04/live-01/attempt-02/transform.py --out out/excel-p04-replay.json
```

输出路径必须不存在，Docker 镜像准备方法同原型说明。重放证明固定脚本和输入的行为，不新增模型能力证据。
