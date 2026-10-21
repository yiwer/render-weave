# 25: Gemini 的长调用不再在约 300 秒处失败

**What to build:** `agent run` 选 Gemini 时，转换代理（`src/agent/model-proxy.ts`）向上游发 `streamGenerateContent?alt=sse`，收齐各分块后照旧交给 Claude Code；上游失败按连接、状态码、流中三个阶段记日志并带底层原因，Claude Code 照常重试。

**Blocked by:** 无

**Status:** resolved

**Trace:** M232（转换代理）；本票决定记 M287；票据 21（评估按错误文字给上游错误分类，依赖 429 的 `rate_limit_error` 与"429"字样）。

背景：2026-10-20 用一张阿拉伯文公交站牌走完整 Agent 流程（`out/arabic-board/`，不进版本库），Gemini 4 Argon 的模板辅助设计轮反复在约 300 秒处失败。临时中继把上游改成流式后跑通。

**实测证据**

- **r4 的失败**（`out/arabic-board/r4-template/logs/model-proxy.jsonl`）：17 次调用里 5 次 502 `fetch failed`，耗时 306.5–309.0 秒。最后三次连续，Agent 卡在一次写出大模板的长输出上，整轮 31.9 分钟（`round.json` 的 `wallMs` 1,912,499）没有成果，退出码 1。日志只有 `fetch failed`，看不出底层原因。
- **原因在代理自己的 fetch，不在上游**（本票实测，推翻了之前"已排除"的结论）：本机 Node v24.12.0，本机服务器延迟回包，`fetch(…, { signal: AbortSignal.timeout(600000) })`：
  - 响应头 305 秒后才回：304.6 秒报 `fetch failed`，cause 是 `UND_ERR_HEADERS_TIMEOUT`；
  - 响应头立即回、响应体中途 305 秒没有数据：304.6 秒报 `terminated`，cause 是 `UND_ERR_BODY_TIMEOUT`。
  - 全局 fetch（undici）的响应头与响应体超时都固定 300 秒，`AbortSignal` 只能缩短不能延长；不装 undici 包就改不了。非流式 `generateContent` 要等整次生成结束才回响应头，所以生成超过 300 秒必断。r4 的 306.5–309.0 秒 = 300 秒加上传请求体（含图片）的时间，推断就是这个超时。
- **上游支持 SSE**：`POST https://opencode.ai/inference/go/google/v1beta/models/gemini-4-argon-contributor:streamGenerateContent?alt=sse`（带 `x-opencode-session`、`x-goog-api-key`、`user-agent: renderweave-model-proxy/1`）3 秒回 `text/event-stream`，分块持续到达。
- **临时中继跑通**（`out/arabic-board/relay.jsonl`，r5/r6 共 99 次调用加 1 次探测）：上游改流式、合并 parts、取最后一块的 `usageMetadata` 与 `finishReason`，请求加 `generationConfig.thinkingConfig.includeThoughts: true`。
  - 没有再出现约 300 秒的切断。最长一次 297.8 秒。
  - 首个分块最晚 236.6 秒才到，分块间最长停顿 231.6 秒，都在思考期间。中继若也用 fetch，停顿超过 300 秒仍会断；这批数据没碰到。
  - 2 次上游 HTML 502（Cloudflare 网关页），分别在 168 秒、83 秒后才回状态码，不是切断。
  - 2 次 `finishReason: MAX_TOKENS`：32k 输出全耗在思考上。
  - functionCall 上的 `thoughtSignature` 合并后完整保留，`fromGoogle` 依赖它。
- **Claude Code 2.1.296 怎么对待代理的各种交回方式**（本票实测）：用本机假 Anthropic 服务按场景回包，跑 `claude -p`，不调用模型：

  | 代理交回 | Claude Code 的下一步 |
  |---|---|
  | HTTP 502 | 退避 0.5 秒、1 秒…重试，仍走流式，`stream.jsonl` 记 `api_retry`（`error_status: 502`） |
  | HTTP 429 | 同上，`api_retry` 记 `error_status: 429`、`error: "rate_limit"` |
  | 已回 200，流里发 `error` 事件（`api_error` 或 `rate_limit_error`） | 立即改发一次非流式请求，不退避、不记 `api_retry`；非流式再失败才按状态码退避 |
  | 已回 200，流中直接断开连接 | 退避后重试，仍走流式，`api_retry` 记 `error_status: null`、`error: "unknown"` |
  | 设 `CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1` 后在流里发 `error` 事件 | 不重试，整轮以 `API Error: …` 结束 |
  | 响应头推迟 20 秒 | 正常完成，没有触发首字节超时 |
  | 流式响应只发 ping，310 秒后才给结果 | 正常完成 |
  | 非流式请求 310 秒没有任何数据 | 正常完成（`API_TIMEOUT_MS=600000`） |

  所以在 Claude Code 一侧，合并后再交回足以支撑超过 300 秒的调用；300 秒的限制只在代理连上游的那一段。

**决定**（M287）：

- **上游走流式**：发 `:streamGenerateContent?alt=sse`。解析 SSE 的 `data:` 行：网络分块可能截断在行中间（包括多字节字符中间），按行缓冲；按事件合并多行 data。按顺序收集各分块的 parts，`usageMetadata` 与 `finishReason` 取最后出现的值，合并后交给不变的 `fromGoogle`。
- **连上游用 `node:http`/`node:https`，不用全局 fetch**：fetch 的两个 300 秒超时改不了。代理自己的连接池随本轮关闭。
  - 原来整次 600 秒的上限改为套接字 600 秒没有任何数据就放弃，连接、等响应头与流中停顿都算。流式时生成可以合理地超过 600 秒，总长由输出上限约束。
  - 切换条件：上游出现超过 600 秒的思考停顿时再调大。
- **打开 `includeThoughts`**：思考摘要随流送达，长思考时链路上也有数据；代理本来就丢掉 `thought: true` 的部分，Claude Code 看到的结果不变。中继跑了 99 次没有副作用。
  - 它不保证思考期间一直有数据，中继里首个分块最晚 236 秒才到，所以不能代替上一条。
  - 切换条件：同一场景的 `output_tokens` 因思考摘要明显上升，或上游拒绝 `thinkingConfig` 时关掉。
- **结果判定**：
  - 流正常结束但没有任何分块给出 `finishReason`，按流中断处理；
  - 流里出现 `{"error": …}` 时取其中的 `code` 作状态码，不是 HTTP 状态码时按 502；
  - 提示词被拦下（只有 `promptFeedback.blockReason`）算正常结束，与非流式时一样交回空文本。
- **交回 Claude Code**：
  - 流式请求的响应头等上游回了 200 才发，最迟到第一次 ping（15 秒）。
  - 在此之前出错（连不上上游、上游非 200），照上游状态码交回：429 仍是 `rate_limit_error`，消息仍以"上游 429："开头，票据 21 的分类不受影响。Claude Code 照 HTTP 状态退避重试，仍走流式。
  - 之后出错（流中断、没有结束原因、流里报错）只能在流里发 `error` 事件，类型按状态码映射，502 是 `api_error`；Claude Code 随即改发非流式请求重试，实测不受 300 秒影响。
  - 非流式请求照旧，按状态码交回。
  - 不设 `CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK`：设了以后流里的 `error` 事件不再重试。
  - 不改成直接断开连接：断开虽然也会重试，但 Claude Code 拿不到错误文字。
- **日志**：`logs/model-proxy.jsonl` 仍不记内容，新增以下字段：
  - 成功记 `events`（SSE 分块数）与 `maxGapMs`（响应体分块间最长停顿）；
  - 失败记 `phase`（`connect` / `status` / `stream`）、`cause`（底层错误的 `code` 与 `message`，如 `ECONNRESET`、`ECONNREFUSED`；空闲超时记 `IDLE_TIMEOUT`）、`events` 与 `idleMs`（失败前多久没收到上游数据）。
- **不在本票**：
  - 把上游的增量边收边转给 Claude Code：实测合并后交回已够用；
  - 思考预算（票据 23）；
  - 代理自己重试：交给 Claude Code。

- [x] 上游请求是 `:streamGenerateContent?alt=sse`，带 `accept: text/event-stream`，请求体带 `generationConfig.thinkingConfig.includeThoughts: true`。
- [x] 分块截断在行中间与多字节字符中间、CRLF 与 LF 两种换行、文字与工具调用分在几个分块里：转回的结果与非流式时相同；functionCall 的 `thoughtSignature` 在下一次请求补回；用量取最后一块。
- [x] `finishReason: MAX_TOKENS` 转成 `stop_reason: max_tokens`，思考 token 计入输出。
- [x] 上游回 200 后流中断、没给结束原因、在流里报错：流式请求收到 `error` 事件；非流式请求收到 502 `api_error`。
- [x] 上游 429：流式请求也收到 HTTP 429 `rate_limit_error`；连不上上游：502 `api_error`。
- [x] 日志按 `connect` / `status` / `stream` 记阶段，带 `cause.code`（流中断 `ECONNRESET`、连不上 `ECONNREFUSED`）、`events` 与 `idleMs`；成功记 `events` 与 `maxGapMs`；产物中没有 key。
- [x] 离线用例用本机假上游，不调用模型、不读 key；全量 `npm test` 与 `npm run typecheck` 通过。
- [x] `docs/agent-tasks.md`、M232 与 `CODING_STANDARDS.md` 写明代理走流式、连上游不用 fetch。

**测试接缝：** `test/agent.test.ts`「选 Gemini 时经本机转换代理」：`runAgentTask` 加假执行器 `test/support/fake-claude.mjs` 的 `.model-calls.json`，假上游按字节分段写出 SSE、写到一半关掉连接。

## Answer

2026-10-20 完成。没有提交，留给用户决定。

**成果**

- `src/agent/model-proxy.ts`：
  - 上游发 `:streamGenerateContent?alt=sse`，`node:http`/`node:https` 加本代理自己的连接池（随本轮关闭）；`readSse` 按行缓冲，事件间以空行分隔，最后一个事件后面缺空行也交出。
  - 合并后交给不变的 `fromGoogle`。
  - 流式请求的响应头在上游回 200 时或第一次 ping 时发出；失败的交回与日志字段按「决定」一节。
- `test/agent.test.ts`「选 Gemini 时经本机转换代理」从 2 项增加到 3 项：
  - 原有一项改成假上游按 17 字节一段写 SSE（截断在行中间与汉字中间、CRLF），文字与工具调用分在 4 个分块里，用量先给中间值；另一个回复用 LF。
  - 新增一项覆盖：思考耗尽 32k 输出的 `MAX_TOKENS`；按 9 字节一段写、写到第三块中间断开；没有结束原因；流里报 503；流式请求遇到 429；非流式请求遇到断开；连不上上游（端口刚关掉）。
- 文档：`docs/agent-tasks.md` 的 `--model`/`--endpoint` 与 `logs/` 两处；M287，M232 末尾加指向；`CODING_STANDARDS.md` 引擎边界一条；`docs/dev-setup.md` 期望测试数；索引加一行。

**验证**

- `npx vitest run test/agent.test.ts -t 转换代理`：3 项通过。变异核对：把 `readSse` 改成不保留跨分块的半行，2 项失败（文字只剩空、日志的分块数对不上），改回后通过。
- `npm run build` 后 `npm test`：47 个文件、940 项全过（原 939 项加新增 1 项）；`npm run typecheck` 退出码 0。Windows，Node v24.12.0。
- 真实链路：`--model gemini-4-argon-contributor` 对阿拉伯文站牌跑一轮数据定义提取（示例图与项目说明同 `out/arabic-board/r1-definition`，`--domain route-sign`），轮次目录 `out/ticket25/r1-definition-gemini/`（worktree 内，不进版本库）。
  - 结果：`qualified`，问题 0 条，退出码 0，用时 12.6 分钟，27 个回合，输出 44,083 token。
  - `model-proxy.jsonl`：12 次调用全部 200，没有 `api_retry`，多轮工具调用的 `thoughtSignature` 补回正常。最长一次 291.0 秒（74 个分块、输出 25,283 token，分块间最长停顿 15.3 秒）；所有调用里最长停顿 49.4 秒。
  - 轮次目录与命令输出里没有 key（按内容检索）。
- 实测 Node fetch 超时与 Claude Code 行为的脚本放在会话临时目录，没有进仓库，结论与方法写在「实测证据」。

**对票据的偏差与未验证**

- 真实链路这一轮没有一次超过 300 秒（最长 291 秒），所以"超过 300 秒不再断"只由两处实测推断：fetch 的 300 秒超时实测、`node:http` 没有这个限制，以及 Claude Code 能等 310 秒。下一步：模板辅助设计轮或 Gemini 评估的模板场景里出现超过 300 秒的调用时，看 `model-proxy.jsonl` 那条是否 200。
- 响应头已发出后（上游 15 秒还没回状态码）再失败的路径，离线用例没有覆盖，要等 15 秒；流中断走的是同一个分支，已覆盖。
- 600 秒空闲上限没有离线用例。
- Gemini 评估门槛没有重跑，按 M232 的先例只跑一轮真实数据定义提取核对；`includeThoughts` 改了发给模型的请求，下一次 Gemini 评估一并确认成绩。

## Comments

- 2026-10-20 开票。交接里"已排除 Node fetch 自身的 300 秒响应头超时"与本票在同一台机器上的实测相反，以本票为准；当时的脚本没有保留，差别在哪里未知。
