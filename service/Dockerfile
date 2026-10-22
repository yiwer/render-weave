# 出图服务镜像（ADR-0017）：接口进程与 worker 共用一个镜像，按命令区分。
# 构建上下文是仓库根目录（允许清单见根目录的 .dockerignore）。镜像里不放任何凭据，配置只经环境变量传入（M259）。

# 引擎：与命令行同一份源码与锁文件。
FROM node:22-alpine AS engine
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci
COPY src ./src
RUN npm run build
# DSL 的 JSON Schema：开放 API 的描述把批次请求、渲染请求与数据集的 Schema 原样收进来（票据 11）。
COPY schemas ./schemas

# 服务：只经 service/src/engine.ts 引用引擎的公开入口；编译用引擎同一版本的 TypeScript。
FROM engine AS service
COPY service/package.json service/package-lock.json service/
RUN cd service && npm ci
COPY service/tsconfig.json service/tsconfig.build.json service/
COPY service/src service/src
RUN cd service && ../node_modules/.bin/tsc -p tsconfig.build.json
# 出图控制台（票据 12）：React 加 Vite 的单页应用，构建到 service/dist/console，由接口进程在 /console/ 下提供。
COPY service/console service/console
RUN cd service && ../node_modules/.bin/tsc --noEmit -p console && node_modules/.bin/vite build console

# Docker 后端测试的素材：控制台的浏览器测试用 Alpine 的 Chromium，由 playwright-core 驱动（票据 12）；测试夹具的字体由准备脚本下载并核对哈希。
# 这一段不依赖源码：改了源码重建 tester 时不用重装 Chromium、重下字体（票据 15）。
# ALPINE_MIRROR 可选：直连 Alpine 源太慢时换成镜像源，如 https://mirrors.aliyun.com（见 docs/dev-setup.md「已知的坑」）。
FROM node:22-alpine AS test-assets
ARG ALPINE_MIRROR=
RUN if [ -n "$ALPINE_MIRROR" ]; then sed -i "s#https://dl-cdn.alpinelinux.org#$ALPINE_MIRROR#" /etc/apk/repositories; fi && apk add --no-cache chromium
WORKDIR /app
COPY scripts/fetch-fonts.mjs scripts/fonts.json scripts/
COPY fixtures fixtures
RUN node scripts/fetch-fonts.mjs

# Docker 后端测试：引擎源码、共用的存储合同用例与测试夹具。
FROM test-assets AS test
ENV RW_CHROMIUM=/usr/bin/chromium
COPY --from=service /app ./
COPY docs/examples/m402-dsl docs/examples/m402-dsl
COPY test/support test/support
COPY service/migrations service/migrations
COPY service/vitest.docker.config.ts service/
COPY service/test service/test
CMD ["node_modules/.bin/vitest", "run", "--config", "service/vitest.docker.config.ts"]

# 运行：只有生产依赖。构建标识在镜像里算一次写进 /app/BUILD_ID，供打标签（ADR-0019）；运行时仍按实际文件计算。
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=engine /app/dist dist
COPY --from=engine /app/schemas schemas
COPY service/package.json service/package-lock.json service/
RUN cd service && npm ci --omit=dev && npm cache clean --force
COPY --from=service /app/service/dist service/dist
COPY service/migrations service/migrations
RUN node service/dist/main.js build-id > /app/BUILD_ID
USER node
EXPOSE 8080 8081
CMD ["node", "service/dist/main.js", "api"]
