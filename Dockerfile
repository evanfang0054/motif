# syntax=docker/dockerfile:1

# ---------- 构建阶段：安装依赖 + Next.js 构建 ----------
# bookworm 完整镜像自带 python3/make/g++，better-sqlite3 源码编译兜底
FROM node:22-bookworm AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.20.0 --activate

# 镜像源（国内网络直连 npmjs 常超时；better-sqlite3 预编译二进制走 npmmirror 二进制镜像）
ENV npm_config_registry=https://registry.npmmirror.com/ \
    better_sqlite3_binary_host_mirror=https://registry.npmmirror.com/-/binary/better-sqlite3 \
    npm_config_fetch_retries=5 \
    npm_config_fetch_timeout=180000 \
    npm_config_fetch_retry_mintimeout=20000 \
    npm_config_fetch_retry_maxtimeout=120000

# 先拷贝清单（含 .npmrc 镜像源声明），利用层缓存
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/image-provider/package.json packages/image-provider/package.json

# 项目根 .npmrc 已声明 npmmirror 镜像源（容器与宿主机一致）；store 换 v2 缓存避免携带旧的坏解析
RUN --mount=type=cache,id=pnpm-store-v2,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# 再拷贝源码并构建
COPY . .
RUN pnpm build

# ---------- 运行阶段：仅带运行时产物 ----------
FROM node:22-bookworm-slim AS runner
WORKDIR /app/apps/web
ENV NODE_ENV=production \
    PORT=3100 \
    HOSTNAME=0.0.0.0 \
    MOTIF_DATA_DIR=/app/apps/web/.data

COPY --from=builder /app/node_modules /app/node_modules
# pnpm workspace 的符号链接层（apps/web/node_modules/.bin/next → 根 .pnpm），必须原样保留
COPY --from=builder /app/apps/web/node_modules /app/apps/web/node_modules
COPY --from=builder /app/apps/web/.next /app/apps/web/.next
COPY --from=builder /app/apps/web/public /app/apps/web/public
COPY --from=builder /app/apps/web/package.json /app/apps/web/package.json
COPY --from=builder /app/packages /app/packages
COPY --from=builder /app/package.json /app/package.json
COPY --from=builder /app/pnpm-workspace.yaml /app/pnpm-workspace.yaml

RUN mkdir -p /app/apps/web/.data
EXPOSE 3100

# better-sqlite3/sharp 已随 node_modules 复制；@motif/* 源码包在构建期已被打包进 .next/server
CMD ["node", "./node_modules/next/dist/bin/next", "start", "-p", "3100"]
