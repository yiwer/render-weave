# 视觉反馈的真实模型纠偏试验

2026-10-22，Claude Haiku 5.5 已在一次受控中文任务中完成“读局部差异 → 修改 → 再比较 → 最终核对”。6 项分项异常降到 0；只改要求中的四项属性，页脚与其余结构不变。当前结论是工具闭环可用，不是实际订单成功率或整体相似度已获验证。

## 输入与结果

输入是 100×60 mm 合成站牌，真值先由固定模板生成。站名故意设置为错误文字“科枝园”、5 mm、向右偏移 8 mm、红色；参考是“科技园”、10 mm、左边距 10 mm、深蓝色。页脚作为不许改动的对照。宿主固定两个区域及参考图哈希，设计模型只能读取诊断、修改候选，不能改基准。

| 项目 | 实测 |
|---|---|
| 模型 / Claude Code | `claude-haiku-5-5` / `2.1.296` |
| 运行耗时 / 轮数 | 76,587 ms / 23 |
| 输出 / thinking tokens | 5,964 / 2,636（thinking 是输出组成，不重复相加） |
| 输入 / 缓存读 / 缓存写 tokens | 16 / 210,223 / 35,245 |
| 工具比较 | 两次成功：`needsWork` → `needsReview` |
| 分项异常 | 6 → 0；含字号、错字、颜色、宽高和位置 |
| 修改范围 | `中文对照/站名` 的 content、fontSize、color、place.left；其余完全一致 |
| 最终检查 | `qualified`，`visual.status:needsReview`，未知区域仍为 2 |

模型第一次未传 `templates` 且还没有 outcome，工具返回“文件不存在：outcome.json”；模型下一次传入预置模板自行恢复。此次额外错误算入耗时与轮数，没有删掉失败调用。修改要求已明确仅允许四项改动，所以此试验只证明模型能利用校准诊断完成指定修复，不能证明模型自主发现全部错误的能力。

最后一次 `compare_reference.reportId` 与宿主最终 `check.json` 相同；修复前后的 ID 不同。原始轮次保存输入/资料/提示词/构建标识、工具和模型日志。模型没有取得原始真值模板文件。

## 复现

```powershell
node --import tsx scripts/prepare-agent-visual-live.mjs
# 原轮次目录须保留；再次运行时另取 --out 目录。
node dist/bin.js agent run --task template-revision --sample out/agent-visual-live/sample.png --reference out/agent-visual-live/reference.json --brief out/agent-visual-live/brief.md --requirement out/agent-visual-live/requirement.md --workspace out/agent-visual-live/workspace --resources fixtures/resources --request out/agent-visual-live/request.json --out out/agent-visual-live/round-1 --max-turns 30
node --import tsx scripts/check-agent-visual-live.mjs
```

第一、三条不调用模型；第二条需要 `OPEN_CODE_API_KEY` 与可执行的 Claude Code，真实消耗模型额度。本机通过 `--claude` 明确指定 native `claude.exe`，避免 PATH 上同名 shim 无法启动。默认输出目录已存在时改用新轮次名，并作为校验脚本第二个参数传入。

`out/agent-visual-live/round-1/` 是真实运行记录；`verified/` 是当前源码的离线复核，含改前/改后报告、内容图、局部三联图与汇总。真实模型使用启动时的 dist 构建，未包含随后修复的大规模问题截断；离线复核使用当前源码，两个构建哈希不同，不能混称同一次运行。完整四场景门槛另外记录，不用本试验替代。

## 尚未证明

真实中文、英文站牌的全部独立样式/状态、英文真实模型纠偏、人工排序相关性不能由这次中文小样例推出。按 M307 不再以阿文还原作为验收前置；其历史测量保存在[原图参考](examples/arabic-reference/README.md)。

## 合同 0.10.1 独立复跑（2026-10-23）

为避免改变正在跑的 0.10.0 门槛，最新源码单独编译到 `out/agent-builds/visual-feedback-0.10.1/dist/`，并复制同一份 agent、schemas、web 与包清单。实际运行来源记录为合同 `0.10.1`、引擎 `sha256:635a378346b033b29da54ff8cee5eb7ed5d5780c20a469fec5e634f78169ae99`。原工作区 dist 未替换。

相同输入、相同授权范围，Haiku 完成第二次独立纠偏：184,673 ms、20 轮、4,426 输出 tokens（其中 thinking 1,378）；输入 18、缓存读 242,251、缓存写 41,540。两次比较从 6 项异常降到 0，没有工具错误；候选与仅修改四项属性的预期文档完全相同。最后比较与宿主检查的 reportId 均为 `da9f24f018439d55d3cac1202f5f53478844bf35cf70de47f98739c663135b72`，最终仍保留 `needsReview` 与 2 个未知区域。已查看同尺度三联图，文字、大小、颜色与位置对齐。

```powershell
node out/agent-builds/visual-feedback-0.10.1/dist/bin.js agent run --task template-revision --sample out/agent-visual-live/sample.png --reference out/agent-visual-live/reference.json --brief out/agent-visual-live/brief.md --requirement out/agent-visual-live/requirement.md --workspace out/agent-visual-live/workspace --resources fixtures/resources --request out/agent-visual-live/request.json --out out/agent-visual-live/round-0101 --max-turns 30
node --import tsx scripts/check-agent-visual-live.mjs out/agent-visual-live out/agent-visual-live/round-0101 out/agent-visual-live/verified-0101
```

第三个脚本参数指定独立校验输出目录，保留原 `verified/` 证据。此例只有 2 个区域，不证明模型会翻页；分页由 86 区域原图重放、100 区域公开 MCP 回归和长 ID 边界验证。此例也不替代 0.10.1 的固定场景模型门槛。
