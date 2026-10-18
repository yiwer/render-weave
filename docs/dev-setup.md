# 开发环境与接续：在另一台设备上继续

从仓库检出后，照本页准备环境与几份不进版本库的材料，就能接着推进。要做的事见 [CONTEXT.md](../CONTEXT.md)「当前阶段与下一步」，工作规则见 [AGENTS.md](../AGENTS.md)。原设备上 Claude Code 的记忆目录是空的，仓库之外没有别的约定。

## 1. 软件

| 软件 | 版本 | 用途 |
|---|---|---|
| Node.js | 22 或以上；Windows 实测 v24.21.0，Linux 容器 v22.23.3 | 构建、测试、命令行 |
| Git | 任意 | 检出与提交 |
| Claude Code | 评估通过时是 2.1.296 | `renderweave agent run` 的运行环境（ADR-0015）。PATH 上要有可执行文件 `claude`（Windows 上是 `claude.exe`），只有 `claude.cmd` 不行，见「已知的坑」 |
| Docker | 可选；原设备是 Docker Desktop 29.8 | 在 Linux 容器里跑全量测试（A12） |
| 浏览器 | 任意 | `renderweave agent review` 的审核页 |

**Claude Code 版本不同时要跑评估门槛**：升级 Claude Code、换模型、改资料、改工具合同之后，都要跑一次评估，连续两次达线才能用（ADR-0015、M230）。做法见下文「常用检查」。

## 2. 安装与自检

在仓库根目录执行：

```powershell
npm ci
npm run fetch-fonts
npm run build
npm run typecheck
npm test
```

- `fetch-fonts` 要联网，按 `scripts/fonts.json` 固定的版本与 SHA-256 下载到 `fixtures/resources/fonts/`。
- 期望结果：Windows 上 39 个文件、752 项全部通过。Linux 上另有 4 项跳过，都是 `it.runIf(process.platform === 'win32')` 的 Windows 专用用例。

## 3. key 与模型服务

模型经 OpenCode Go 套餐调用（M232），原设备的套餐是 Go Plus。

- **key**：只有一个，放在环境变量 `OPEN_CODE_API_KEY`，由维护者在每台设备上自行设置，不进仓库。
  - Windows：在"编辑账户的环境变量"里新建，然后重开终端；已经打开的终端读不到新变量。
  - Linux 与 macOS：在仓库之外的 shell 配置里设置，或者每次会话前设置。
  - 不要把 key 写进仓库、命令行或脚本。renderweave 只从环境变量读取它，不写文件、不打印。
- **模型**：
  - 缺省 Claude Haiku 5.5，命令里不用写模型参数；
  - 质量要求高的单子加 `--model gemini-4-argon-contributor`，renderweave 会在本机自动起转换代理。
  - 千问不再使用，`QWEN_TOKEN_PLAN_API_KEY` 不需要设置。
- **额度**：OpenCode Go 按 5 小时、每周、每月三个窗口计。实测几个模型的 5 小时窗口同时用完，按共用一个池安排，不要同时跑太多轮。用完时命令输出"模型服务报错"，带 429。
- **用时与费用参考**：
  - Haiku：代建一轮 1–9 分钟；评估一整遍各轮之和约 39 分钟。
  - Gemini：模板一轮 21–25 分钟；评估一整遍约 72 分钟，按标价约 $14。
- **数据去向**：示例图、项目说明、工作区快照与工具返回的预览图会经 OpenCode 发给模型提供方（Haiku 是 Anthropic，Gemini 是 Google）。客户资料能否外发要先确认。

## 4. 不进版本库的材料

| 材料 | 原设备位置 | 新设备怎么得到 | 什么时候要 |
|---|---|---|---|
| 价签示例图 | `C:\Users\yiwer\Pictures\25411738_224650821323_2.jpg` | 从原设备拷贝。它是 1024 × 669 的 JPEG，135,621 字节，SHA-256 `8a131227294c44858973375aaa484d477b6ac4ef75d36faec06c0cf454c0faa9`。放到 `out/samples/pricetag-sample.jpg` 一类被忽略的位置 | 票据 09 的真人计时；重跑价签流程 |
| 外部项目源码快照 | `outside_context/`（979 MB） | 拷贝 `outside_context/renderweave-external-sources-20261012-205149.zip`，在仓库根解压为 `outside_context/`。说明在包内的 `README.md`，逐文件哈希在 `manifest.json` | 需要引用旧 RenderWeave、rid-rs、design-layout-draw、CloudKiln 的事实时（CONTEXT「外部来源」） |
| 字体 | `fixtures/resources/fonts/` | `npm run fetch-fonts` | 测试与出图 |
| 实跑产物 | `out/`（约 8 GB） | 不需要。各票的结论与数字已写进票据、[第三阶段验收](stage3-acceptance.md)与 `docs/agent-eval/reports/` | 文档中提到的 `out/...` 路径只在原设备上有 |

**价签示例图不能进版本库**：它是带水印与素材编号的第三方素材（M222）。提交前用 `git status` 确认没有把它加进来。M402 与 366 的示例图在 `docs/examples/materials/`，已经在仓库里。

## 5. 常用检查

**Linux 全量测试**：把会进版本库的文件打成 tar，在容器里从空目录安装，不挂载宿主的 `node_modules`。Windows 上用 Git Bash 执行：

```bash
mkdir -p out/linux && git ls-files -co --exclude-standard | node -e "const fs=require('fs');const files=fs.readFileSync(0,'utf8').split('\n').filter(f=>f&&fs.existsSync(f)&&fs.statSync(f).isFile());fs.writeFileSync('out/linux/files.txt',files.join('\n')+'\n')" && tar -cf out/linux/snapshot.tar -T out/linux/files.txt && MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W)/out/linux:/fresh" node:22-alpine sh -c "mkdir /work && tar xf /fresh/snapshot.tar -C /work && cd /work && npm ci && npm run build && npm run typecheck && npm test"
```

在 Linux 或 macOS 上，把 `$(pwd -W)` 换成 `$(pwd)`，并去掉 `MSYS_NO_PATHCONV=1`。

**key 扫描**：每次真实运行之后、提交之前执行。参数是本次的轮次目录与改过的目录。0 命中才算过，命中时退出码 1，只输出路径不输出 key：

```bash
node scripts/scan-keys.mjs out/<本次的轮次目录> docs src scripts test
```

**评估门槛**：怎么跑见 [Agent 评估](agent-eval.md)。

```bash
npm run build
npx tsx scripts/agent-eval/run.ts --label <名称>
npx tsx scripts/agent-eval/run.ts --label <名称> --model gemini-4-argon-contributor
```

- 第一条用缺省的 Haiku，第二条用 Gemini。
- 只改了部分场景读的资料时，可以只重跑受影响的场景。用报告里的 `materials` 哈希证明其余场景的资料没变（M230）。

## 6. 已知的坑

- **Windows 上用 npm 装的 Claude Code**：`npm install -g @anthropic-ai/claude-code@2.1.296` 在全局目录里只放 `claude.cmd` 与 `claude.ps1` 两个 shim。终端里 `claude --version` 能用，但 `agent run` 不经 shell 启动子进程，只认 `.exe`，结果每轮都是"无法启动 claude：spawn claude ENOENT"。
  - 原生程序在 `<npm 全局目录>\node_modules\@anthropic-ai\claude-code\bin\claude.exe`，全局目录用 `npm prefix -g` 查。
  - 解决：把这个 `bin` 目录加进 PATH；或者单次运行用 `--claude <claude.exe 的完整路径>`。
  - 评估命令不接受 `--claude`，只能改 PATH。可以只对当前终端改：`$env:Path = "<bin 目录>;" + $env:Path`。
- **Docker 把宿主的本机代理注入容器**：Docker 客户端配置了代理时（如 `http://127.0.0.1:10808`），容器里也有 `HTTP_PROXY` 等变量。可是容器里的 127.0.0.1 是容器自己，`npm ci` 会连接被拒，最后报"Exit handler never called!"。遇到这种情况，在容器命令开头加 `unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY &&`，让容器直连 npm 镜像源。

- **命令行提交审核操作**：Windows 的 Git Bash 里用 `curl` 发中文，会按本机代码页发出，审核服务按 UTF-8 严格解码，返回 400。审核请在浏览器里操作；确实要用脚本时，用 Node 的 `fetch` 发 UTF-8 JSON。
- **正式出图要资源版本仓库**：`fixtures/resources` 只能用于发起任务与审核预览。`deliver` 前先 `resources-init`，再 `resources-import`，见[代建指南](agent-guide.md)第 7 步。
- **模板辅助修改要有数据集**：模板设计用的出图请求没写数据集时，修改轮要加 `--dataset`。
- **带反馈的下一轮不沿用模型**：第 1 轮用 Gemini 的话，`--from` 的下一轮也要加 `--model`。
- **后台进程**：`agent review` 的审核页按 Ctrl+C 结束。用脚本在后台启动的话，结束后要自己停掉，否则端口一直占着。
