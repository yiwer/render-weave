# 待验候选与计划绑定

候选包保留经核查的共同代码、构建、资料、Schema、公开审核页静态资源（`web/`）、工具合同、默认策略和实际安装依赖。计划绑定另存自己的输入、评分配置、资源依据、请求模型/effort/预算及执行器身份；原四场景、可信反馈和留出计划可以使用同一候选，各自保留独立结论。格式与取舍见 M327、[ADR-0026](adr/0026-immutable-candidate-and-plan-bindings.md)。

## 冻结前

先完成责任票的合同、资料、记录兼容和样例同步，运行 `npm run typecheck`、`npm run build`、`npm test -- --maxWorkers=1`。两平台分别复核涉及渲染的共享样例图片及布局摘要，保存命令、环境和字节清单。自动回归或冻结成功都不能代替后续真实模型活动；资料策略最终决定尚未完成时只准备工具，不发布最终候选。

冻结期间保持来源不变。依赖应由锁文件独立安装，不能用工作树之间的目录链接；包会保存实际 node_modules 文件，含 WASM、tsx 和平台需要的 esbuild。`.bin`、`.cache`、`.vite`、`.vite-temp` 是可再生命令链接/缓存，不是模型执行资料。默认评估 JSON 和各案例文件属于逐计划内容，不混进共同输入。

```sh
npx tsx scripts/agent-eval/freeze.ts --out out/acceptance/candidate-1
npx tsx scripts/agent-eval/freeze.ts --verify out/acceptance/candidate-1
npx tsx scripts/agent-eval/freeze.ts --verify out/acceptance/candidate-1 --current
```

`--verify` 检查包内字节；加 `--current` 还核对当前执行内容与 Node。包内 `content/` 是实拷贝，原工作目录后来构建或修改资料不会改变它。目标目录必须不存在，失败的半成品没有有效发布清单，不能拿它派发。清单中的内容身份不是 Git 提交别名。包内公开审核服务从 `content/web/review.html` 读取页面，该字节纳入共同身份；缺失或改动会使 `--verify` 拒绝。

## 按计划绑定和派发

原四场景使用当前核准的配置，新增可信反馈使用准备工具产出的独立配置。以下路径是命令示例，实际验收应使用核准输入和持久目录：

```sh
npx tsx scripts/agent-eval/freeze.ts --bind out/acceptance/candidate-1 --config scripts/agent-eval/config.json --out out/acceptance/four-scenarios
npx tsx scripts/agent-eval/freeze.ts --bind out/acceptance/candidate-1 --config out/approved-feedback/config.json --out out/acceptance/feedback
npx tsx scripts/agent-eval/run.ts --config scripts/agent-eval/config.json --candidate-binding out/acceptance/four-scenarios --label acceptance-four --out out/acceptance/four-observations
```

绑定接受与实际运行相同的 `--scenarios`、`--repeat`、`--model`、`--small-model`、`--endpoint`、`--effort`、`--max-turns`、`--timeout-ms`、`--stagnation-threshold`、`--context-policy`、`--claude` 和 `--claude-args`。质量/成本配对加 `--paired --jobs N` 固定调度条件；普通实验的并行数继续作为调度事实。绑定本身只调用执行器的 `--version`，不读取密钥、不调用模型。提供方修订未知保持 null。

`binding.json` 列出每个场景/次数/阶段，`config.json` 保存原评分配置，`resources/` 保存实际字体和图片字节。首次派发及后续轮次重核共同候选、当前构建、安装依赖、输入、配置、资源、执行器和预算；不匹配列出差异并拒绝模型启动。候选和绑定损坏也拒绝。实际运行的 `eval.json` 与报告记录绑定 ID 和候选 ID；同标识续跑不能去掉或替换绑定，旧实验不能追加绑定后冒充原来已固定。

原始输入路径不自动重写成可迁移工作区；输入移走或改动应先创建新计划。留出材料可以先独立准备，在派发前绑定最终候选；冻结不等待留出材料，也不把校准输入当成留出输入。

## 人工审核链的逐阶段绑定

19 的留出程序包含独立数据集阶段和每阶段人工审核应用，不是自动转录评估。每个阶段另写一份请求（以下绝对路径为占位示例）：

```json
{
  "format": "renderweave-stage-request/1",
  "unit": "landscape/case-01/run-1/dataset/attempt-01",
  "materials": [
    {"file": "F:/approved/preparation-manifest.json", "sha256": "sha256:<已核准的64位摘要>"},
    {"file": "F:/approved/approval.json", "sha256": "sha256:<实际用户核准记录摘要>"},
    {"file": "F:/approved/budget-policy.json", "sha256": "sha256:<核准预算摘要>"}
  ],
  "upstreamRounds": ["F:/observations/unit-01/definition/attempt-01"],
  "args": [
    "--task", "dataset-extraction", "--definition", "线路牌",
    "--workspace", "F:/observations/unit-01/workspace",
    "--sample", "F:/approved/case-01/source.jpg", "--brief", "F:/approved/case-01/brief.md",
    "--resources", "F:/approved/resources", "--content-baseline", "F:/approved/case-01/dataset-baseline.json",
    "--out", "F:/observations/unit-01/dataset/attempt-01",
    "--model", "claude-haiku-5-5", "--small-model", "claude-haiku-5-5",
    "--max-turns", "40", "--timeout-ms", "3600000", "--stagnation-threshold", "2",
    "--context-policy", "full", "--claude", "C:/tools/claude.exe"
  ]
}
```

所有实际使用的原图、说明、基准、请求和当前工作区/资源均从 `args` 自动取字节身份。`materials` 额外列出宿主需核验的核准材料及政策；摘要必须来自实际核准包，不以当前文件自动补造批准。`upstreamRounds` 列本阶段所依赖的人工已应用轮次，逐个通过公开审核读取核对应用凭据属于同一工作区，再固定完整轮次字节，包含原件、人工修正和应用记录。独立空白阶段或核准种子不冒充上游 Agent 成功，可不提供该数组。预算参数按核准政策填写；本入口固定这些事实，不自行解释任意业务政策 JSON。

```powershell
node node_modules/tsx/dist/cli.mjs scripts/agent-eval/stage.ts --bind F:/acceptance/candidate-1 --request F:/observations/dataset-request.json --out F:/observations/dataset-binding
node node_modules/tsx/dist/cli.mjs scripts/agent-eval/stage.ts --verify F:/observations/dataset-binding
node node_modules/tsx/dist/cli.mjs scripts/agent-eval/stage.ts --dispatch F:/observations/dataset-binding --key-env OPEN_CODE_API_KEY
```

绑定和预检不读密钥、不调用模型。派发重核同一候选和全部阶段来源后，仅调用一次与 `dist/bin.js agent run` 相同的公开 CLI；不提供自动审核、应用、重试或业务循环。所有参数一旗标一值，拒绝重复或未知旗标，路径须绝对；凭据仅以派发时的环境变量读取。`dispatch-start.json` 独占消费绑定，`dispatch.json` 关联候选、绑定、单元、退出码和原始轮次文件摘要；失败也保留，不能重用绑定覆盖派发。运行期间来源变化记为无效，不能计入该候选。

`materials`、其他案例真值和 correctedWorkspace 均不会因为绑定而复制给模型；只有 `args` 指定的本例、本阶段输入沿既有 Agent 准备路径传入。每次审核、修改、应用继续使用19原程序的公开入口；下一阶段使用应用后的真实工作区重新创建绑定。接续同样新建请求，用 `--from`、`--feedback` 和可选 `--checkpoint`，沿公开恢复读取核对前轮、所选完整检查点及它实际提供的快照工作区/资源；强退后没有 `round.json` 也遵循该入口，存活或未知拥有者仍拒绝。工作区、前轮和上游输入目录拒绝符号链接，不能因目录枚举漏算 JSON 链接而放行。核准材料、代码或预算改变须新候选/绑定与影响清单；已有阶段原件保留，不以新绑定替换旧来源。

## 改动后的重验

有任何代码、资料、工具或默认预算变化，重新构建与核查，写入新候选目录。为每个受影响的计划重新绑定，并指向旧绑定：

```sh
npx tsx scripts/agent-eval/freeze.ts --out out/acceptance/candidate-2
npx tsx scripts/agent-eval/freeze.ts --bind out/acceptance/candidate-2 --config scripts/agent-eval/config.json --out out/acceptance/four-scenarios-v2 --previous-binding out/acceptance/four-scenarios
```

新绑定的 `revalidation` 列出旧身份、全部差异和需要重验的确切单元。首版保守地重验该计划所有单元，不把旧、新候选的成功结果拼接。其他计划要各自生成比较清单。原包、绑定、报告均保留；新评分仍通过已有 `--rescore` 另存结果，不改旧报告，也不补造历史身份。

阶段 5 的默认直接发布、可选审批及托管边界不变。本地候选合格只表示可以进入相应真实验收计划，不能宣称客户自助上线。
