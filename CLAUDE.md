# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目

Motif —— AI 商业图片批量生成工作台（参考图 + 模板 → 成套出图）。pnpm monorepo（pnpm@11.20.0，Node ≥20）：`apps/web` 是 Next.js 15 全栈应用（App Router，页面与 API Route Handlers 同进程，端口 3100）；`packages/core`（领域类型/额度规则/状态机）、`packages/db`（SQLite 存储层）、`packages/image-provider`（OpenAI 兼容生图网关）。

## 设计系统

主题色遵循根目录 DESIGN.md（Claude 风：暖米画布 + 珊瑚 #cc785c 主操作色 + 暖黑暗色），令牌落地在 `apps/web/src/app/globals.css`（`:root` 亮色基准 + `html[data-theme="dark"]` 暗色覆盖；三态切换 light/dark/system 默认 light，见 `ThemeToggle.tsx` + `layout.tsx` 内联脚本）。守护线：图片画布 `--canvas-background` 保持中性色；`--status-*` 为功能性语义色，不强制暖化。

@DESIGN.md

## 语言与提交约定

- 代码注释、文档、UI 文案一律中文。
- 提交信息：Conventional Commits + 中文描述，如 `fix: 取消生成时退还额度`。

## 常用命令

- `pnpm dev` — 本地开发 http://localhost:3100；首次需 `cp apps/web/.env.example apps/web/.env` 并填入 `IMAGE_API_BASE_URL` / `IMAGE_API_KEY`（缺省时首个触发生图的请求才报错，无 mock 降级）
- `pnpm typecheck` — 全仓 `tsc --noEmit` 严格检查，是唯一的静态检查门禁（项目未配置 ESLint/Prettier）
- `pnpm test` — 全部 Vitest 单测（core/db/provider/web 各自 `test/*.test.ts`）；单包跑 `pnpm --filter @motif/core test`
- `pnpm build` — 构建 @motif/web
- `pnpm cdk <CODE> <N>` / `pnpm cdk --list` — CDK 发放/查询 CLI（与 apps/web 共用数据库）
- `pnpm test:e2e`、`bash e2e/acceptance.sh` — ⚠️ ego-browser 驱动、直跑真实生图网关并消耗额度：仅当用户明确要求时运行

## 关键机制与坑

- workspace 包直接导出 TS 源码（`main: src/index.ts`），没有构建产物，靠 Next `transpilePackages` 编译；跨包引用用 `workspace:*`。
- `@/*` 别名指向 `apps/web/src/*`（tsconfig paths + vitest alias 均已配置）。
- SQLite（better-sqlite3, WAL）schema 在服务端首次 `getRuntime` 时懒建表；数据默认在 `apps/web/.data/`（`MOTIF_DATA_DIR` / `MOTIF_DB_FILE` 可覆盖），生成图片存 `.data/storage/`。
- 本地联调注册需 `MOTIF_EXPOSE_DEV_CODE=1`（验证码随接口直出）；生产环境严禁开启。
- 额度按张扣费，生成失败/取消必须退额（额度守恒是验收项）；改动计费、队列或 worker（`apps/web/src/server/worker.ts`）时必须保持守恒。
- 原生依赖 better-sqlite3 / sharp 首次安装需编译（已通过 pnpm-workspace.yaml `allowBuilds` 放行；.npmrc 走 npmmirror 二进制镜像）。
- 端口：dev 3100 · e2e 3210 · acceptance 3220；e2e 脚本自行 `next start`、清空 `.data-e2e` / `.data-accept`，缺 `.next` 时自动先 build。
- CI（main）= `pnpm install --frozen-lockfile` → typecheck → test → build；e2e 不在 CI 中。提交前本地至少通过 typecheck + 单测。
