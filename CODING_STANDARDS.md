# 编码约定

供实施者与 `/code-review` 的 Standards 轴使用。这里只收已在 ADR、M 编号决定或现有代码中落实的约定；新约定先形成决定，再写进来。DSL 命名与参照项目的规则在 `AGENTS.md`「项目约定」。

## 引擎边界

- 渲染引擎是不依赖框架的 TypeScript 模块，运行在 Node 22 上（ADR-0011）。HTTP 服务外壳、依赖注入框架不进入 `src/`。命令行附带的单用户本地页面不算服务外壳，例如 `agent review` 的审核页：只用 `node:http`，只绑定 `127.0.0.1`，不出图、不发布（M227）。`agent run` 在轮次宿主内起的 Anthropic 转发与 Gemini 模型转换代理同理：只用 `node:http`，只绑定 `127.0.0.1`，随本轮关闭，只认本轮令牌（M232、M321）；它连上游用 `node:http`/`node:https` 的客户端，不用全局 `fetch`，因为 fetch 的响应头与响应体超时固定 300 秒，长生成会被切断（M287）。命令行调用出图服务的 `push` 是客户端，只用全局 `fetch`，同样不算服务外壳（M264）。
- 出图确定性：字体只从资源仓库显式加载，不读系统字体；SVG 只传入资源仓库的字体（ADR-0011、ADR-0012）。同一输入在 Windows 与 Linux 上应得到相同的图片和摘要；改动渲染路径时，用 `scripts/accept-*.mjs` 中对应的脚本复核。
- CanvasKit 加载 full 构建（`src/canvaskit.ts`），默认构建不能编码 JPEG。

## 测试

- **接缝**：通过公开入口观察外部行为。渲染、发布、资源管理、交付与重放从 `src/index.ts` 进入，命令行参数、退出码与文件成果从 `src/cli.ts` 进入；不测试私有中间结构。夹具与像素工具在 `test/support/`。
- **预重构**：需要的小范围预重构先做，并保持已有测试通过，再写新行为。
- **布局摘要**：用 `toMatchFileSnapshot` 存到 `test/snapshots/`；有意改变时用 `npx vitest run -u` 更新，并在 diff 中核对每处变化。
- **图片**：与 `test/golden/` 按像素差阈值比对，失败时在 `test-output/golden/` 生成"预期、实际、差异"三联图。有意改变出图时用 `UPDATE_GOLDEN=1 npm test` 更新；设了 `CI` 时缺少 golden 直接失败。
