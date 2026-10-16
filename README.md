# RenderWeave

以数据定义、模板与数据集生成 PNG/JPEG 的 TypeScript 渲染引擎。首期完成发布、校验、求值、布局、出图及命令行闭环；第二阶段增加二维码与条形码、资源内容版本、批量正式交付和可脱离工作区重放的出图记录。主要验收样例为 M402 公交线路牌。

## 运行样例

需要 Node.js 22 或以上版本。首次准备字体需要联网，字体版本和 SHA-256 固定在 `scripts/fonts.json`；渲染使用本地资源。

```powershell
npm ci
npm run fetch-fonts
npm run build
node dist/bin.js render --workspace docs/examples/m402-dsl --resources fixtures/resources --request docs/examples/m402-dsl/render-request-m402.json --out out/m402
```

成功时输出 `image.png`、`problems.json`、`layout.json`；默认样例为 3496 × 780 px、120 DPI。修改请求的 `parameters.currentIndex` 可以切换本站；`0` 表示不标本站。修改 `mode` 为 `draft` 可查看有问题的草稿。

渲染退出码：`0` 已出图（草稿可能仍有严重问题，须检查问题清单）；`1` 未出图或执行失败；`2` 参数或请求文件读取错误。再次使用同一输出目录会清除上次的图片、摘要和问题清单，避免旧成果被误认为本次成功。独立调用可并发；CLI 同一输出目录应串行使用。

## 发布静态数据定义

```powershell
node dist/bin.js publish --definition path/to/schema-example.json --workspace path/to/published --out path/to/published
```

`--workspace` 必须是已存在且可读取的工作区，首次发布使用空目录即可，无需资源清单。待发布的数据定义文件放在工作区外，省略 `version` 由发布自动递增；已有版本要完整保留在工作区中。发布生成带版本号的定义与编译产物，目标文件已存在则失败，不能覆盖。可捕获的写入错误会撤回本次创建的文件；本地文件发布不提供断电或进程强杀时的事务保证。

发布退出码：`0` 已发布；`1` 校验或写入失败；`2` 参数、定义文件读取或原始数字精度错误。失败原因写到标准错误流。

## 批量交付与重放

第一次使用请照[使用指南](docs/guide.md)走一遍：导入资源、交付 35 项、定位失败项、替换资源，再脱离原工作区重放出图记录，每步写明命令与预期退出码。

## MCP 只读工具服务

```powershell
node dist/bin.js mcp --workspace docs/examples/m402-dsl --resources fixtures/resources --root path/to/round
```

给业务 Agent 或任何 MCP 客户端使用：标准输入输出上按行分隔的 JSON-RPC。工具全部只读，包括读取、校验、草稿预览、元素检查、局部放大与 DSL 参考。工作区在启动时读入为快照，读文件的工具只能读 `--root` 内的文件。工具合同与限制见 [MCP 工具服务](docs/mcp.md)。

## 业务 Agent 任务

```powershell
node dist/bin.js agent run --task 数据定义提取 --sample path/to/sample.png --brief path/to/brief.md --resources fixtures/resources --out out/rounds/r1 --domain route-sign
```

发起一轮数据定义提取；数据集提取用 `--task 数据集提取 --definition <数据定义> --workspace <工作区>`，模板辅助设计用 `--task 模板辅助设计 --dataset <数据集ID> --request <出图请求.json> --workspace <工作区>`，修改已保存的模板用 `--task 模板辅助修改 --request <出图请求.json> --requirement <修改要求.md> --workspace <工作区>`。审核不通过时用 `--from <上一轮目录> --feedback <反馈.md>` 发起下一轮，沿用上一轮的输入，并拿到上一轮成果（含审核时的修改）与反馈。Claude Code 在空白环境中以受限模式运行，只连只读 MCP 服务；key 只从环境变量读取，缺省 `QWEN_TOKEN_PLAN_API_KEY`，用 `--key-env` 可换成别的变量，例如 OpenCode Go 的 `OPEN_CODE_API_KEY`。成果先校验结构，再经引擎校验，退出码 0 表示合格、1 表示不合格。

```powershell
node dist/bin.js agent review out/rounds/r1
node dist/bin.js agent apply out/rounds/r1 --workspace path/to/workspace
```

`agent review` 在本机打开审核页：对照示例图逐项处理待确认项（采纳候选、改值或标为空），其余内容整体确认一次，有出图请求时对照 RenderWeave 重新渲染的预览（模板辅助修改时是修改前后两张，另有相对已保存模板的改动表），然后通过或不通过；审核结果随时保存到轮次目录的 `review.json`。`agent apply` 只接受审核通过的轮次，把数据定义发布为下一个版本，数据集与模板保存为新文件，模板的工作副本替换已保存的模板，之后可用 `deliver` 正式出图；工作区自成果生成后变了，就列出差异（要改的模板已被他人保存时另列他人的改动）并拒绝，加 `--overwrite` 才按当前工作区写入，或用 `--from` 重做。轮次目录、成果格式、审核与应用见 [业务 Agent 任务](docs/agent-tasks.md)；从示例图走到出图与修改的整套操作见 [代建指南](docs/agent-guide.md)。

## 验证与文档

```powershell
npm test
npm run typecheck
npm run build
node scripts/accept-m402.mjs out/stage1/m402
node scripts/accept-stage1.mjs out/stage1/stability
```

- [首期阶段验收与 DSL 能力边界](docs/stage1-acceptance.md)：可靠性、鲁棒性、可用性结果及延期范围。
- [第二阶段验收](docs/stage2-acceptance.md)：Windows/Linux 全新环境复跑、跨平台哈希比对、使用指南实测与两轴审查。
- [第三阶段验收](docs/stage3-acceptance.md)：Agent 代建的验收矩阵、价签与 366 两张新示例图的端到端记录、模型对比与两轴审查。
- [资源内容版本](docs/resources-versioning.md)：CLI 导入、替换影响检查、应用替换、查询旧版和固定版本出图。
- [批量正式交付、草稿预览与出图记录](docs/output-records.md)：35 项 M402 逐项交付、批量草稿、混合失败与退出码、模板调用与素材依赖、取消与中断辨认、同批去重、独立复制及确切构建重放。
- [M402 DSL 样例](docs/examples/m402-dsl/README.md)：可直接运行的 JSON 写法。
- [M402 外观验收](docs/examples/m402-acceptance.md)：参考图差异与场景结果。
- [草稿与正式模式](docs/render-modes.md)、[字体](docs/render-fonts.md)、[SVG](docs/render-svg.md)：问题处理和资源约定。
- [EAN/UPC 条形码](docs/render-retail-barcodes.md)、[商品编号样例](docs/examples/retail-barcode-dsl/README.md)：完整编号、校验位与格式专属留白。
- [CODE128 条形码](docs/render-barcode.md)、[资产编号样例](docs/examples/barcode-dsl/README.md)：资源字体、下方文字与独立解码验收。
- [二维码](docs/render-qrcode.md)、[查询码样例](docs/examples/qrcode-dsl/README.md)：文本绑定、可执行命令与最终图片解码验证。
- [DSL 1.0 参考](docs/dsl/README.md)：五种文档的写法、JSON Schema 与一致性测试。
- [MCP 工具服务](docs/mcp.md)：`renderweave mcp` 的工具合同、只读与路径限制。
- [代建指南](docs/agent-guide.md)：用 Agent 把一张示例图做成可出图的模板，命令可以直接复制。
- [业务 Agent 任务](docs/agent-tasks.md)：`renderweave agent run`、`review`、`apply` 的选项、隔离、轮次目录、成果校验、审核与应用。
- [Agent 评估](docs/agent-eval.md)：升级 Claude Code、换模型、改资料或改工具合同之后必须跑的评估，场景、通过线与报告；交给 Agent 的资料与归属规则见 [agent/README.md](agent/README.md)。
- [CONTEXT.md](CONTEXT.md)：开发接续入口与文档地图。

二维码、CODE128、EAN/UPC、资源版本导入与替换、批量正式交付与草稿预览（1–1,000 项串行）、记录重放、项间取消与中断后辨认、同批素材硬链接去重，以及码图模板的交付与重放已在第二阶段实现，见[第二阶段验收](docs/stage2-acceptance.md)。记录支持完整 M402、PNG/JPEG/WebP/SVG、字体与码图；第三阶段已有 DSL 1.0 参考与 Schema、只读 MCP 工具服务、数据定义提取、数据集提取、模板辅助设计与模板辅助修改及其审核与应用、带反馈的下一轮；URL 图片、HTTP 服务、OCR、在线编辑器仍未实现。领域模型文档包含未来设计，当前可执行能力以各期阶段验收及对应 DSL 样例为准。
