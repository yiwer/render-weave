# 2026-10-23 待验候选与离线验收记录

本轮共同候选已具备进入真实验收的离线依据。验证由固定基线全量、责任修复回归和最终受影响回归组成，并非对最终源码再跑一次全量；原始失败及其关闭证据全部保留。候选冻结不代表原四场景、可信反馈或留出案例的模型门槛已通过，本票真实模型观测为 0。

## 唯一候选

- 内容身份：`sha256:72a5e74973ce5f60e501e27060f6bc4a52f51f7b4bd45bbbac39502e0a5b949f`。
- 持久目录：`F:/GenCode/render-weave/out/harness-acceptance-20/candidate-2`；后续实际运行目录是它的 `content/`，不再依赖 C 盘实施工作树。
- 最终执行源码：`60515d5d1c5d51f6404c36ff050d72d02164b14e`，包括审查修复 `a02329a`、责任票记录 `749966f`、兼容夹具修正 `65ecbcf` 与来源路径修复 `7339fab`。共同包保存 3322 个真实文件，含实际构建、资料、Schema、公开审核页及安装依赖，文件副本不链接回工作树。
- MCP `0.17.0`；转录评分器 `renderweave-transcription/3`；匹配策略 `ordered-occurrences/1`。票18决定保留 `full`，模型及小模型为 `claude-haiku-5-5`，effort 缺省/null，整轮 3600000 ms，停滞阈值 2，提取40轮、模板80轮。实际提供方模型修订仍为 null，不能声称固定了提供方内部实现。
- 清单固定的 Node 身份为 Windows x64 `v24.12.0`，二进制 SHA256 `2ffe3acc0458fdde999f50d11809bbe7c9b7ef204dcf17094e325d26ace101d8`。原生 Claude 不嵌入包；两计划共同固定 `D:/nodejs/node_global/node_modules/@anthropic-ai/claude-code/bin/claude.exe`、`2.1.296 (Claude Code)`、SHA256 `76de74f7694a5bdc03378a5f837c9e132827bf004c98c276bc4e9094ff06769a`。

[候选与计划证据](../../out/harness-acceptance-20/candidate-readiness-2.json)核对最终构建的 Windows 字节与包内3322文件，差异为空；[发布步骤](../../out/harness-acceptance-20/publication-2/steps.json)保存命令、实际 cwd、时间和退出码。冻结后先从包内执行 `--verify --current`，准备/绑定完成后再核对，均退出0。[证据索引](../../out/harness-acceptance-20/evidence-index-2.json)保存原始日志、环境、图片、清单与外部验证脚本 SHA；不修改旧报告或旧失败日志。

候选1 `sha256:e3025450299922dc027f880197926cb48e1ee6fec663309b941eddc1328ff26a` 及其两份绑定保留原件，真实观测为0；首次派发前发现公开 `contextPolicy.sources` 路径标签漏首字母，15份资料哈希没有遗漏或覆盖，完整 `identity.materials` 与共同包身份另有正确覆盖。仍选择先修复再发布候选2，候选2发布时真实观测也为0。两份新绑定用 `--previous-binding` 保存旧身份、差异及全部10/16阶段重验清单；21从新包重新准备到 `inputs-2/`，旧种子与旧计划不改写，不拼接两候选结果。

## 验证组成与失败闭环

| 验证 | Windows | Linux | 固定依据 |
| --- | --- | --- | --- |
| 全量81文件 | 1296通过、4失败、14条件跳过，2668.88s | 1288通过、3失败、23条件跳过，1677.10s | `4f17dc39d6be1444aff49ade87563242609e011d` |
| 三项审查修复5文件 | 67通过，753.51s | 67通过，512.58s | `a02329a`，责任记录 `749966f` |
| 候选1整合后受影响4文件 | 69通过、1平台条件跳过，528.41s | 69通过、1平台条件跳过，288.36s | `2fe039a` |

全量阶段两平台均运行 `npm run build`、`npm run typecheck`、`npm run typecheck:service`、`npm test -- --maxWorkers=1`。服务与控制台静态检查均通过；本票没有重新执行要求外部后端的 Docker 服务端验收。Windows 启用了真实原生 Claude 权限引擎夹具，上游为本地协议模拟，没有真实模型调用。Linux 为 Node `v22.23.3` / Alpine 3.24.2，在镜像 `sha256:35178de1086a772fd500f6248780e910c002f8940c686f77fec98aeaec0ad63d` 的独立副本执行，使用 `docker run --rm --init`；没有 Linux 原生 Claude 二进制，对应条件用例保留跳过，不用 Windows 结果冒充该平台已测。

原始全量日志：[Windows](../../out/harness-acceptance-20/validation/windows/full-tests.log)、[Linux](../../out/harness-acceptance-20/validation/linux/full-tests.log)。失败逐项关闭如下：

1. 两处测试仍期待合同 `0.16.0`，一处工具清单漏了 `outcome_feedback`。按现行公开合同更新断言，未改变产品代码或降低验收。
2. Windows 取消隔离用例中，独立 B 轮的7秒预算包含等待 A 取消、保存、恢复的耗时。独立重现仍失败；[原始公开状态](../../out/harness-acceptance-20/validation/windows/cancel-reproduction-state.json)记录 B `status: stopped`、`reason: timeout`、预算7000 ms、实际8404 ms，A 的取消与接续断言已通过。只将该隔离夹具预算改到30秒，保留其他真实截止测试及失败诊断，定向绿测11.594s；没有以单独重跑变绿推断根因。
3. 独立 Spec 审查另发现透明色 fit 假通过、同站额外/重复地标漏报、冻结包漏审核页。分别退回01/02/20责任修复，公开红绿及两平台5文件67项在[修复证据目录](../../out/harness-prefreeze-fixes)。评分器升版，不重写既往报告。

候选1整合后的四文件命令为 `node node_modules/vitest/vitest.mjs run test/agent-rounds.test.ts test/agent-eval.test.ts test/agent-dataset-template.test.ts test/agent-budgets.test.ts --maxWorkers=1`。两平台 build/typecheck 通过，[Windows日志](../../out/harness-acceptance-20/validation/final/windows/affected-tests.log)、[Linux日志](../../out/harness-acceptance-20/validation/final/linux/affected-tests.log)均无失败。审查修复五文件为 `agent-template-behavior`、`agent-eval-transcription`、`agent-candidate-freeze`、`agent-visibility`、`agent-eval-identity`。

Linux 首次环境准备因复制的 lock 文件时间触发依赖重装，npm 在测试开始前失败，保存在 `validation/linux-setup-attempt-1/`。修复仅发生在外部准备脚本：先核对已安装依赖对应的锁文件内容，再同步安装标记时间；没有改项目锁文件或用失败启动算通过。完整命令与外部脚本归档在 `validation/tooling/`。

来源路径修复仅将 `materialHashes` 的字符串切片改为 `path.relative`，不改变文件选择、哈希算法、提示或预算；新增 full/on-demand 两条公开实验来源反例，验证路径可定位且与实验资料、轮次 provenance 逐文件相同。[修复证据](../../out/harness-context-source-fix)保留2红→2绿；Windows/Linux 的 identity、context-policy、context-trial 三文件均38通过，分别311.52s/227.20s，build/typecheck均过。票17补记录并重新关闭，既有18报告不改写。

## 共享样例、合同与实际字节

两平台均通过 `context.ts --check`、`accept-m402.mjs`、`check-svg-platform.mjs`、`accept-stage1.mjs`。M402七案例、SVG四张图以及请求/布局/问题摘要共35份产物逐字节一致；稳定性入口每平台39次成功渲染、33个无效请求拒绝，输入不变。稳定图指纹 `785e0aad9beebf1203a6fd78284c69ab9606fa7d2323af94bd6bb50aabbfda72`、布局指纹 `d8b398bf8f14f983dc2eb8d08a4e027f2661fa48e9d6c11d2f79b70e81d84b2e`，3496×780、120 dpi。详见[平台对照](../../out/harness-acceptance-20/validation/platform-comparison.json)。耗时/RSS仅本机观察，不是服务容量承诺。

资料检查确认合同/引用/Schema，保留原 Agent 外围票20的已知未解决资料指针，结果 `known-unresolved`、`candidateReady: true`，没有伪造为全无问题。此前责任票完成的旧完整轮次读取与接续、缺身份重新检查、旧报告另存重评分兼容，均包含在基线全量及对应公开回归中；本票未改历史记录格式。

每轮测试前后均逐文件核对，期间没有合并或改源。基线清单身份 Windows `6ed928d751300dfe3154f86d2d1fcf057aa18a3b883404cba687890c86b8b6f3`、Linux `f4582594ae5940c3cfdfb505a89fbe5dd11597a2c273314eb28768b2605ffef4`；候选1整合后 Windows `ab9df2dd33a6ae9a6b656c05ff7057f9142e5c7e8b9babf76294f0890c0c432f`、Linux `706126acbdfd87123c6de8a6de01a17921e58d8706f4625ee8922c9d4d6e2982`。这些是各自环境的清单摘要，不要求平台依赖二进制相同。

[候选1整合对照](../../out/harness-acceptance-20/validation/final-platform-comparison.json)列出了基线之后的全部差异；两平台共同源/资料无差异，当时的 `src/dist/agent/schemas/fixtures/docs/examples/package*.json` 与基线相同，因此共享渲染对照可复用。`web/review.html` 是最终清单新增覆盖项，不是渲染算法变更。评分与冻结修复由五文件回归覆盖，旧合同断言和取消夹具由最终四文件覆盖，未将不同候选的真实模型成功拼接。

候选2重建、静态检查及前后字节捕获后，清单为 `0596ace94e69ffb4482544c0fa45569eea4e518d862dd44af8a7a05142aaaf47`。[来源修复增量对照](../../out/harness-acceptance-20/validation/metadata-comparison.json)强制差异仅为 `src/agent/provenance.ts`、对应JS/SourceMap及新增公开身份测试，测试/发布期间没有其他执行内容变化。渲染源码和资料未变，因此保留此前两平台图片/摘要结果；没有宣称来源标签修复后又跑了一遍渲染或全量。

公开冻结回归还实测：包内审核 GET 200；工作目录重新构建、改资料/审核页不改已冻结包；当前来源或输入变化在模型启动前列差异并拒绝；同一包绑定不同计划；新候选与旧绑定比较列出全部需重验单元；重复消费阶段绑定拒绝；真实宿主强退后没有 `round.json` 的完整检查点仍沿公开恢复入口接续。实际依赖/WASM和字体字节有独立副本及摘要，目录/文件链接不能绕过快照。

## 后续计划的确切绑定

| 计划 | 配置/绑定目录 | 绑定身份与范围 |
| --- | --- | --- |
| 原四场景（原38） | `F:/GenCode/render-weave/out/harness-acceptance-20/plans/original-four/config.json`；同目录 `binding-2/` | `sha256:889bb317a86a29339982a79b7a7f68db6a86fe392768ac9a69dca9d70190c655`；4场景×2次，8个观测、10个执行阶段 |
| 可信反馈（21） | `F:/GenCode/render-weave/out/harness21-trusted-feedback/inputs-2/config.real-model.json`；该计划根目录 `binding-2/` | `sha256:b2a1a7e53f303dfb184b417fa78248251bedd49a84e46dabe7280785ada06505`；中英文×4任务×2次，16个阶段 |

原四场景实验身份为 `sha256:de9aa1f0550751340efcf5113ab4fdac6b87d63377dba3c63d43cee1b500616e`，21实验身份为 `sha256:5e69585bf0ceb8ca62800889af0dccb94e0974606b894bd34e2c2cae7d925961`（分别对 binding.identity 的 JSON 字节求 SHA256）。

两计划均已由持久候选 `content/` 内的冻结入口创建，资源与输入全部使用 F 盘绝对路径。原四场景的52份输入/资源独立复制，仅改配置路径，评分阈值不变，`preparation.json` 保留来源与目标摘要。21由同一候选的 `prepare-feedback.ts` 完整准备8类受控种子；原 `config.json` 仍标机制证据，独立 `config.real-model.json` 只把 `evidence` 登记为 `real-model`，差异见 `inputs-2/real-model-registration.json`，不将种子冒充模型结果。`plan-2.json` 记录16单元 ready、16次真实观测均 not-run。

实际派发从以下持久目录启动，沿同一运行请求；`--label`、输出与报告目录由计划负责人确定并保持续跑一致。不能先从工作树启动再把路径写成候选来源。

```powershell
Set-Location F:/GenCode/render-weave/out/harness-acceptance-20/candidate-2/content
node node_modules/tsx/dist/cli.mjs scripts/agent-eval/freeze.ts --verify F:/GenCode/render-weave/out/harness-acceptance-20/candidate-2 --current
$runtime = @('--repeat','2','--jobs','1','--model','claude-haiku-5-5','--small-model','claude-haiku-5-5','--endpoint','https://opencode.ai/inference/go/anthropic','--context-policy','full','--timeout-ms','3600000','--stagnation-threshold','2','--claude','D:/nodejs/node_global/node_modules/@anthropic-ai/claude-code/bin/claude.exe')
# 原四场景或21分别选用上表的 --config 与 --candidate-binding：
# node node_modules/tsx/dist/cli.mjs scripts/agent-eval/run.ts --config <配置> --candidate-binding <绑定目录> --label <本计划固定标签> --out <持久观测目录> --reports <持久报告目录> @runtime
```

绑定/预检不读取模型密钥、只探测执行器版本。真实运行才从 `OPEN_CODE_API_KEY` 读取凭据；普通计划固定 jobs1 派发，不添加 `--paired`。首次及每个后续阶段均重核来源，报告保留共同候选与逐计划绑定ID。不同计划仍各自得出质量结论。

19的已核准材料目录为 `F:/GenCode/render-weave/out/harness-holdout-review-05`，其36订单/96阶段含人工审核与独立数据集入口。后续使用[逐阶段绑定命令](../agent-candidate-freeze.md#人工审核链的逐阶段绑定)，在每次人工应用后按真实 workspace 重新绑定 `approval.json`、准备清单、预算、原样公开参数及上游应用凭据；材料与审核答案仅供宿主核验，不额外暴露给模型，不替换原 review/apply 程序。新代码/资料/预算/评分须新候选与重验清单，不能修改本包后沿用身份。

阶段5默认直发、可选审批决定保留；这份本地兼容记录不证明租户写入、托管隔离或客户自助已经验收。原四场景归原38，新增反馈归21，留出四类型归22–25，真人走查归26。
