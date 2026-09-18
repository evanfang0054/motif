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

- `pnpm dev` — 本地开发 http://localhost:3100；首次需 `cp apps/web/.env.example apps/web/.env` 并填入 `IMAGE_API_BASE_URL` / `IMAGE_API_KEY`（缺配置不阻断启动：构造占位 provider，首个触发生图的请求才报错，无 mock 降级）
- `pnpm typecheck` — 全仓 `tsc --noEmit` 严格检查，是唯一的静态检查门禁（项目未配置 ESLint/Prettier）
- `pnpm test` — 全部 Vitest 单测（core/db/provider/web 各自 `test/*.test.ts`）；单包跑 `pnpm --filter @motif/core test`
- `pnpm build` — 构建 @motif/web
- `pnpm cdk <CODE> <N>` / `pnpm cdk --list` — CDK 发放/查询 CLI（与 apps/web 共用数据库）
- `pnpm admin:reset` / `pnpm admin:list` — 超级管理员凭据工具（重置密码并吊销其会话 / 查看管理员账号）
- `pnpm test:e2e`、`bash e2e/acceptance.sh` — ⚠️ ego-browser 驱动、直跑真实生图网关并消耗额度：仅当用户明确要求时运行

## 关键机制与坑

- workspace 包直接导出 TS 源码（`main: src/index.ts`），没有构建产物，靠 Next `transpilePackages` 编译；跨包引用用 `workspace:*`。
- `@/*` 别名指向 `apps/web/src/*`（tsconfig paths + vitest alias 均已配置）。
- SQLite（better-sqlite3, WAL）schema 在服务端首次 `getRuntime` 时懒建表；数据默认在 `apps/web/.data/`（`MOTIF_DATA_DIR` / `MOTIF_DB_FILE` 可覆盖），生成图片存 `.data/storage/`。
- **管理员引导**：服务启动时（`instrumentation.ts` 的 `register()`）若库中尚无 `role='root'` 账号，自动创建并把随机强密码写入 `dataDir/admin-credentials.txt`（0600）＋启动日志。幂等依据是**数据库而非凭据文件**。`MOTIF_SKIP_ADMIN_BOOTSTRAP=1` 可跳过。⚠️ 各子步骤（播种 / 启 worker / 引导）**必须各自包 try/catch** —— 建库本身会失败（磁盘只读、路径无权限），不包裹会让进程起不来。
- **配置以 `settings` 表为唯一真相**：启动时 `bootstrapConfig()` 把环境变量播种进库（只写不存在的键，只播非空值），此后读取一律「库优先、回退 env」。`apps/web/src/server/settings.ts` 是唯一声明「有哪些键 / 什么类型 / 能不能写 / 是不是危险区」的地方；改配置走管理后台「系统设置」，改 `.env` 不再生效。**只读键**：`MOTIF_DATA_DIR` / `MOTIF_DB_FILE`（决定数据库位置）与引导类参数永不入库。密钥类键只写不读，读取接口只回掩码。**改了 provider / mailer 相关键要调 `invalidateRuntime()`**（原地替换 provider 与 mailer，store 与 dataDir 必须保持同一实例 —— worker 持有 store）。
- **管理面**：`/admin` 用服务端守卫（非授权 `notFound()` → 404）；`/api/admin/*` 用 `requireAdmin` / `requireRoot`。⚠️ App Router 中 layout 与 page **并行渲染**，layout 的 `notFound()` 拦不住 page 的服务端渲染（其文本会进 404 响应的 RSC flight payload）—— 故管理页**必须客户端取数**走已守卫接口，校验断言用 HTTP 状态码或 `innerText`，**不得 grep 原始 HTML**。
- 本地联调注册需 `MOTIF_EXPOSE_DEV_CODE=1`（验证码随接口直出）；生产环境严禁开启。它在管理后台「危险区」里也能改（需二次确认 + 留痕）。
- 额度按张扣费，生成失败/取消必须退额（额度守恒是验收项）；改动计费、队列或 worker（`apps/web/src/server/worker.ts`）时必须保持守恒。
- 原生依赖 better-sqlite3 / sharp 首次安装需编译（已通过 pnpm-workspace.yaml `allowBuilds` 放行；.npmrc 走 npmmirror 二进制镜像）。
- 端口：dev 3100 · e2e 3210 · acceptance 3220；e2e 脚本自行 `next start`、清空 `.data-e2e` / `.data-accept`，缺 `.next` 时自动先 build。
- CI（main）= `pnpm install --frozen-lockfile` → typecheck → test → build；e2e 不在 CI 中。提交前本地至少通过 typecheck + 单测。
