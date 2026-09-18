# Motif — AI 商业图片批量生成工作台

以「参考图 + 模板 → 成套商业图片」为核心的全栈 SaaS 工作台。
前端为暗/亮双色单页应用（落地页 + 登录后工作台），服务端为 Next.js API 全栈实现，
生图走 OpenAI 兼容网关（gpt-image 系）真实出图。

> 品牌、文案、模板提示词与全部代码均为原创实现。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 前端 | Next.js 15 (App Router) · React 19 · Tailwind CSS 4 · 原生 CSS 设计令牌（暗/亮双主题） |
| 服务端 | Next.js Route Handlers（与前端同仓同进程） |
| 存储 | SQLite（better-sqlite3, WAL），图片文件存于 `.data/storage/` |
| 队列 | 进程内生成 Worker：租约认领 → 逐张生成 → 崩溃回收重排 |
| 生图 | `OpenAICompatProvider`：文生图（images/generations）+ 图生图（images/edits，参考图 multipart） |
| 邮件 | `Mailer` 抽象：console（本地直出）/ SMTP（QQ·163·Gmail 等）/ Resend / SendGrid |
| 测试 | Vitest 单测（core / db / provider / 服务层 / mailer） + ego-browser 端到端测试 |
| 工程 | pnpm workspace monorepo · TypeScript strict · Docker 多阶段构建 |

## Monorepo 结构

```
motif/
├── apps/web/                  # Next.js 全栈应用（UI + API）
│   ├── src/app/               # 页面与 API 路由
│   │   ├── page.tsx           # / ：未登录落地页 / 已登录工作台
│   │   ├── billing/mock-pay/  # 模拟收银台（待接真实支付）
│   │   └── api/               # auth · topics(+watch) · generate-images · canvas-images
│   │                          #   · billing · redeem · feedback · messages/cancel
│   ├── src/components/        # landing / workspace 组件（含交互画布）
│   ├── src/server/            # 会话、业务服务、队列 worker、Mailer
│   └── src/lib/               # 模板定义（原创文案）· API client
├── packages/core/             # 纯领域层：类型 · ID · 额度规则 · 状态机 · 校验
├── packages/db/               # SQLite 存储层（9 张表 + 仓储）
├── packages/image-provider/   # 生图 Provider（OpenAI 兼容网关）
├── scripts/cdk.mjs            # CDK 发放 CLI
├── Dockerfile                 # 多阶段构建（builder 构建 + slim 运行时）
├── docker-compose.yml         # 一键部署：端口/数据卷/环境变量/健康检查
└── e2e/                       # ego-browser 测试：run.sh（主流程 5 轮）+ acceptance.sh（验收 A–F）
```

## 一、支持的能力

### 账号体系（真实）
- 邮箱 + 6 位验证码注册（赠 3 张额度）、登录、退出
- 修改密码（校验旧密码）、忘记密码（验证码重置）、昵称与头像资料修改
- 会话 Cookie（httpOnly · 30 天）、scrypt 口令散列
- ⚠️ 验证码发信取决于 Mailer 配置：`console` 直出（本地）；`smtp/resend/sendgrid` 真实发信

### 生图（真实，走你的网关）
- 文生图：`POST /v1/images/generations`（gpt-image-2）
- 图生图：上传参考图后自动切换 `POST /v1/images/edits`（multipart）
- 尺寸：方图 1024×1024 / 竖图 1024×1536 / 横图 1536×1024 / auto / 自定义（按比例吸附三档）
- 张数 1–12；提示词上限 4000 字；云端排队生成，前端 watch 长轮询实时感知

### 任务系统（真实）
- 任务（Topic）增删改查、重命名、状态机七态（空闲/排队中/生成中/正在停止生成/已完成/失败/已取消）
- 生成取消：未完成张数自动退回额度（含守恒验收）
- 画布：图片自由拖拽、缩放（±/100%/适应/滚轮）、整理布局吸附网格、多选、
  选中浮动工具栏（放大预览 / @引用 / 下载 / 删除确认）、双击灯箱

### 运营与计费（部分真实）
- 额度：按张扣费、失败/取消退回、余额不足拦截
- 充值：套餐（50/100/200/500 张，港元定价 HK$68 起）→ ⚠️ 模拟收银台（真实支付待接入，见 [#14](https://github.com/evanfang0054/motif/issues/14)）
- CDK：CLI 发码 + 页面兑换（真实）
- 邀请：专属邀请码/链接，好友经邀请链接注册自动带上邀请码，双方得利（+3 张/人，上限 3 人）（真实）
- 反馈：提交反馈入库（真实）
- 参考图：上传 PNG/JPG/WebP ≤10MB 作为生成依据

### 工程能力（真实）
- pnpm monorepo · TypeScript strict · 54 个单元测试
- ego-browser 端到端（5 轮）+ 补充验收（A–F，真实网关实跑）
- Docker 多阶段构建一键部署，数据卷持久化，健康检查

## 二、部署与配置

### 必需配置（缺一不可）

| 配置 | 去哪拿 | 放哪里 |
| --- | --- | --- |
| 生图网关地址 | 你的 OpenAI 兼容网关（如 `http://host:3000/v1`） | `IMAGE_API_BASE_URL` |
| 网关令牌 | 网关「令牌」页生成 | `IMAGE_API_KEY` |

### 可选配置（按需）

| 配置 | 说明 |
| --- | --- |
| `IMAGE_MODEL` | 默认 `gpt-image-2` |
| `MOTIF_MAILER` | 验证码发信：`console`（默认，本地直出）/ `smtp` / `resend` / `sendgrid` |
| `SMTP_HOST` `SMTP_PORT` `SMTP_USER` `SMTP_PASS` `MAIL_FROM` | smtp 渠道（QQ 邮箱 = smtp.qq.com:465 + 授权码） |
| `SMTP_SECURE` | 按端口推断 | 465 默认 SSL；非 465 端口如需关闭可设 `false` |
| `RESEND_API_KEY` / `SENDGRID_API_KEY` | 对应 API 渠道 |
| `MOTIF_DATA_DIR` / `MOTIF_DB_FILE` | 数据位置（默认 `apps/web/.data/motif.db`） |
| `MOTIF_EXPOSE_DEV_CODE` | `1` = 验证码随接口直出（仅本地联调/e2e，生产勿开） |
| `MOTIF_COOKIE_SECURE` | 未设置 | `1` = 会话 Cookie 加 Secure 标记（HTTPS 部署时开启；本地 http 联调勿开） |
| `MOTIF_BILLING_MODE` | `mock` | `mock`=演示收银台；`live`=关闭模拟支付（真实渠道接入位） |

### 方式 A：Docker 一键部署（推荐）

```bash
# 1. 在 docker-compose.yml 填两项必需配置（IMAGE_API_BASE_URL / IMAGE_API_KEY）
# 2. 启动
docker compose up -d --build
# → http://localhost:3100，数据持久化在 ./data/
```

### 方式 B：本地开发

```bash
cp apps/web/.env.example apps/web/.env   # 填入网关地址与令牌
pnpm install
pnpm dev                                  # http://localhost:3100
```

> 缺少网关配置时，首个触发生图初始化的请求即报错（配置为懒校验，无 mock 降级路径）。
> 本地联调建议同时设 `MOTIF_EXPOSE_DEV_CODE=1`（验证码页面直出，免开邮箱）。

### 测试

```bash
pnpm test             # 54 个单元测试（core 14 · db 15 · provider 8 · 服务层 9 · mailer 8）
pnpm typecheck        # 严格类型检查
pnpm test:e2e         # ego-browser 端到端主流程（⚠️ 真实网关出图，消耗额度）
bash e2e/acceptance.sh  # 补充验收 A–F（⚠️ 同上）：图生图 · 取消退额守恒 · CDK · 改密 · 画布
```

### CDK 发放

```bash
pnpm cdk MY-CODE-10 10   # 发放一张 10 额度的 CDK
pnpm cdk --list          # 查看全部 CDK 与兑换状态
```

## 快速开始（本地开发）

```bash
pnpm install          # 安装依赖（首次会编译 better-sqlite3 / sharp）
cp apps/web/.env.example apps/web/.env   # 填入网关地址与令牌
pnpm dev              # 开发模式  http://localhost:3100
```
