# 29: `list_resources` 给出字体的字重与覆盖的文字

**What to build:** `list_resources` 对每个字体资源返回字重与它能显示的文字种类（如 `latin`、`cjk`、`arabic`），Agent 选字体时不再靠资源 ID 猜，草稿里少出缺字。

**Blocked by:** 无

**Status:** resolved

**Trace:** M225（只读工具）、M234；2026-10-20 阿拉伯文站牌试跑；与票据 19、22 同批发合同 0.6.0。

背景（2026-10-20，`out/arabic-board/`，不进版本库）：

- `list_resources` 只返回资源 ID 与种类（`src/mcp/tools.ts:125-131`）。Agent 按 ID 选了 `font-ar-black`（Segoe UI Black，没有阿拉伯字形），第一张草图 5 个元素报 `text.glyphMissing`，要再出一次草图才换掉。
- 中文项目同理：资源仓库里的字体是否含某个生僻字、是否有西文字形，Agent 只能出了草图看缺字问题。

**决定**：

- 字体资源多返回 `weight`（OS/2 的字重，读不到时省略）与 `scripts`：在一组固定的探测字上，能显示的比例不低于 95% 的文字种类。种类与探测字：`latin`（A–Z、a–z、0–9）、`cjk`（常用汉字 40 个）、`kana`、`hangul`、`cyrillic`、`greek`、`arabic`、`hebrew`、`devanagari`、`thai`。
- 图片资源不变。字体按需加载、在服务内缓存；读不了的字体返回 `error` 说明，不让整个调用失败。
- 工具说明写明 `scripts` 是抽样判断，具体的字以草稿的缺字问题为准。
- 合同新增输出字段，与票据 19、22 同批升 0.6.0。

- [x] 仓库夹具资源仓库的思源黑体返回 `weight` 与包含 `latin`、`cjk` 的 `scripts`；图片资源没有这两个字段。
- [x] 读不了的字体文件返回带 `error` 的条目，其余资源照常返回。
- [x] 合同快照、`docs/mcp.md` 更新；全量 `npm test` 通过。

**测试接缝：** `test/mcp.test.ts` 经 JSON-RPC 调 `list_resources`，用 `fixtures/resources`；坏字体用临时资源仓库。

## Answer

2026-10-20 完成，合同 0.6.0（M289）。

- **代码**（`src/mcp/tools.ts`）：字体资源多返回 `weight`（OS/2 字重）与 `scripts`。`scripts` 在 10 种文字的常用字上抽样，能显示 95% 以上的算覆盖。服务内缓存一个 `FontStore`，读不了的字体返回 `error`，其余照常；图片资源不变。
- **用例**（`test/mcp.test.ts`）：
  - 思源黑体 Regular 与 Bold 分别是 `weight` 400、700，`scripts` 含 `latin`、`cjk`、不含 `arabic`；图片资源只有 ID 与种类；
  - 临时资源仓库里的坏字体带 `error`，图片照常。
- **资料**：通用做法的"文字能力的边界"写明选字体前看 `scripts`（票据 27）。
- **验证**：全量 `npm test` 通过；同批评估 [2026-10-20-contract-060](../../../docs/agent-eval/reports/2026-10-20-contract-060.json) 门槛通过。
- **偏差**：没有在真实轮次里观察 Agent 是否据此选字体：评估场景都是中文，夹具字体都覆盖。下一次有多文种示例图时看第一张草图有没有缺字。
