#!/usr/bin/env bash
#
# Motif 补充验收 —— 覆盖 run.sh 之外的闭环：
#   CDK 兑换 · 取消退额守恒 · 个人资料改名 · 修改密码与错误路径 · 参考图参与生成
#
# 用法：bash e2e/acceptance.sh
#
# ⚠️ 本脚本直连真实生图网关并消耗额度，仅当用户明确要求时运行；日常门禁是 typecheck + 单测。
#
# ⚠️ 选择器口径（#98-2）：认证 / 充值 / 个人资料等都已弹窗化，旧脚本里的
#   `#auth` / `.ws-modal` / `.ws-modal-mask` / `.lp-alert-error` / `.ws-toast` / `canvas-lightbox` / `pf-name`
#   在当前源码里**零命中**（`id="auth"` 只存在于更早的 AuthCard.tsx）。此处已逐个换成当前真实锚点：
#     · 认证表单           → `#auth-form`（AuthModal.tsx）与 `button[form="auth-form"]`（主按钮在 Footer，靠 form 属性关联）
#     · 工作台弹窗         → `[role="dialog"][aria-label="<标题>"]`（WorkspaceModal 把 title 落到 aria-label）
#     · 报错 Alert         → `[data-testid="auth-error"]` / `[data-testid="profile-error"]`
#     · 个人资料三个输入框 → `[data-testid="profile-*"]`
#     · toast              → `[role="alertdialog"]`（与 run.sh 同口径）
#     · 灯箱               → `[role="dialog"][aria-label="图片预览"]`
#     · 张数输入框         → `.ws-panel input[aria-label^="张数"]`（RAC NumberField 渲染的是 type="text"，不是 number）
#     · 充值入口           → `.ws-nav button[aria-label^="余额"]`（顶栏「余额 + 充值」已合并成一个按钮）
#     · 账号菜单           → `.ws-nav button[aria-label="账号菜单"]`（资料 / 退出收进了下拉）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEB_DIR="$ROOT/apps/web"
PORT=3220
BASE="http://127.0.0.1:$PORT"
export MOTIF_EXPOSE_DEV_CODE=1
export MOTIF_DATA_DIR="${MOTIF_DATA_DIR:-$WEB_DIR/.data-accept}"

# 夹具密码（#98-2）：必须满足 D14 复杂度（≥8 位且同时含大写/小写字母、数字、符号）——
# 早先的 accept-66 / accept-99-new 只有小写+数字+符号，会被客户端先行校验（clientAuthError）直接拦下。
# 只在 shell 侧声明一次；heredoc 是 `<<'EOF'`（不做变量展开），故经临时 env json 传进 JS。
FIXTURE_PASSWORD='Accept-66!'
FIXTURE_NEW_PASSWORD='Accept-99-New!'

cd "$WEB_DIR"

# 判据用 .next/server 而不是 .next：16 里 dev 产物落在 .next/dev，跑过 dev 之后 .next 也存在，
# 拿 .next 当「已有构建产物」会误判。
# 与 run.sh 同理：跑之前建议先停掉 dev（build 会重写 .next/*），但 16 下 dev 与 build 并不互斥。
if [ ! -d .next/server ]; then
  echo "[accept] building..."
  pnpm build
fi

lsof -ti :"$PORT" 2>/dev/null | xargs kill -9 2>/dev/null || true
rm -rf "$MOTIF_DATA_DIR"
mkdir -p "$MOTIF_DATA_DIR"

echo "[accept] starting server on :$PORT"
pnpm exec next start -p "$PORT" > /tmp/motif-accept-server.log 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT

for i in $(seq 1 30); do
  if curl -s -o /dev/null "$BASE/api/billing/packages"; then break; fi
  sleep 1
done
# 访问一次落地页，触发服务端建库（schema 在首次 getRuntime 时应用）
curl -s -o /dev/null "$BASE/"

# 发放一枚验收 CDK（走项目的 cdk CLI）
cd "$ROOT"
node scripts/cdk.mjs MOTIF-ACCEPT-20 20
EMAIL="acc-$(date +%s)-$RANDOM@test.dev"
printf '{"base":"%s","email":"%s","password":"%s","newPassword":"%s"}\n' \
  "$BASE" "$EMAIL" "$FIXTURE_PASSWORD" "$FIXTURE_NEW_PASSWORD" > /tmp/motif-accept-env.json
echo "[accept] account: $EMAIL"

# 生成一张正经尺寸的参考图（供 Round C 真实图生图 edits 使用）
node -e "
const sharp = require('$WEB_DIR/node_modules/sharp')
sharp({ create: { width: 512, height: 512, channels: 3, background: { r: 232, g: 226, b: 214 } } })
  .composite([{
    input: Buffer.from(\`<svg width='512' height='512'><rect x='156' y='156' width='200' height='200' rx='24' fill='#8a6f4d'/><circle cx='256' cy='128' r='40' fill='#b99a6e'/></svg>\`),
    top: 0, left: 0
  }])
  .png().toFile('/tmp/motif-accept-ref.png').then(() => console.log('[accept] 参考图已生成'))
"

fail() { echo "[accept] ❌ FAIL: $1"; exit 1; }

# ---------- A：注册（复用 UI 流程）----------
echo "[accept] A: register"
ego-browser nodejs <<'EOF'
const E2E = JSON.parse((await import('node:fs')).readFileSync('/tmp/motif-accept-env.json', 'utf8'))
const PASSWORD = E2E.password
const task = await useOrCreateTaskSpace('motif acceptance')
await openOrReuseTab(E2E.base + '/', { wait: true, timeout: 30 })
await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
await gotoAndWait(E2E.base + '/', { timeout: 30 })
// 认证已弹窗化：落地页底部的「免费注册」入口点开就是 register 模式（不再有独立 #auth 容器 / 先开登录再切注册）
await js(String.raw`(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === '免费注册')
  if (!b) throw new Error('「免费注册」入口未找到')
  b.click()
  return true
})()`)
await wait(1)
const isRegister = await js(String.raw`document.body.innerText.includes('创建账号')`)
if (!isRegister) throw new Error('注册表单未出现')
const { devCode } = JSON.parse(await browserFetch('/api/auth/register/send-code', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: E2E.email }),
}))
if (!devCode) throw new Error('devCode 未返回')
const script = String.raw`(() => {
  const email = '${E2E.email}'
  const code = '${devCode}'
  const password = '${PASSWORD}'
  const setVal = (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  // 注册表单的字段顺序：昵称 / 邮箱 / 邀请码 / 验证码 / 密码 / 确认密码
  const inputs = [...document.querySelectorAll('#auth-form input')]
  setVal(inputs[0], '验收员')
  setVal(inputs[1], email)
  setVal(inputs[3], code)
  setVal(inputs[4], password)
  setVal(inputs[5], password)
  return inputs.length
})()`
const filled = await js(script)
if (filled < 6) throw new Error('注册表单字段不足: ' + filled)
// 主按钮在 Modal.Footer 里（不在 <form> 内），靠 form="auth-form" 关联 —— 故按 form 属性定位
await js(String.raw`(() => { document.querySelector('button[form="auth-form"]').click(); return true })()`)
await wait(4)
const credits = await js(String.raw`(() => (document.querySelector('.ws-nav').innerText.match(/(?:余额\s+)?(\d+)\s+张/) || [])[1])()`)
cliLog('registered, credits=' + credits)
if (credits !== '3') throw new Error('注册赠送应为 3，实际 ' + credits)
EOF
echo "[accept] A ✅"

# ---------- B：CDK 兑换 ----------
echo "[accept] B: CDK redeem"
ego-browser nodejs <<'EOF'
const task = await useOrCreateTaskSpace('motif acceptance')
await ensureRealTab()
// 充值与余额已合并成顶栏一个入口（无「充值」文字，靠 aria-label 定位）
await js(String.raw`(() => {
  const b = document.querySelector('.ws-nav button[aria-label^="余额"]')
  if (!b) throw new Error('余额/充值入口未找到')
  b.click(); return true
})()`)
await wait(1)
await js(String.raw`(() => {
  const m = document.querySelector('[role="dialog"][aria-label="充值额度"]')
  if (!m) throw new Error('充值弹窗未打开')
  // CDK 入口是 HeroUI Link（渲染成 <a>，不是 button），按可见文字定位
  const link = [...m.querySelectorAll('a, button')].find(x => x.innerText.includes('CDK'))
  if (!link) throw new Error('CDK 入口未找到')
  link.click(); return true
})()`)
await wait(1)
await js(String.raw`(() => {
  const m = document.querySelector('[role="dialog"][aria-label="CDK 兑换"]')
  if (!m) throw new Error('CDK 弹窗未打开')
  const input = m.querySelector('input')
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'motif-accept-20')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)
await js(String.raw`(() => {
  const m = document.querySelector('[role="dialog"][aria-label="CDK 兑换"]')
  const b = m.querySelector('button[type="submit"]')
  if (!b) throw new Error('兑换按钮未找到')
  b.click(); return true
})()`)
let credits = null
for (let i = 0; i < 10; i++) {
  await wait(1)
  credits = await js(String.raw`(() => (document.querySelector('.ws-nav').innerText.match(/(?:余额\s+)?(\d+)\s+张/) || [])[1])()`)
  if (credits === '23') break
}
cliLog('CDK redeem → credits=' + credits)
if (credits !== '23') throw new Error('CDK 兑换后应为 23（3+20），实际 ' + credits)
// 兑换成功后弹窗自动关闭（Workspace 的 onRedeemed 会 setDialog(null)）；若仍在则点关闭按钮兜底
await js(String.raw`(() => { const c = document.querySelector('[role="dialog"][aria-label="CDK 兑换"] [aria-label="关闭"]'); if (c) c.click(); return true })()`)
await wait(1)
EOF
echo "[accept] B ✅"

# ---------- C：参考图上传并参与生成 ----------
echo "[accept] C: reference image participates in generation"
ego-browser nodejs <<'EOF'
const task = await useOrCreateTaskSpace('motif acceptance')
await ensureRealTab()

// 新建任务并上传参考图（512×512 PNG）
await js(String.raw`(() => {
  // 该按钮在右侧生成面板的**面板头**里（不是顶栏），图标化后只有 aria-label
  const b = document.querySelector('button[aria-label="新任务"]')
  if (!b) throw new Error('「新任务」按钮未找到')
  b.click(); return true
})()`)
await wait(2)

// 上传参考图（prologue 已用 sharp 生成 512×512 PNG 到 /tmp/motif-accept-ref.png）
await uploadFile('.ws-panel input[type="file"]', '/tmp/motif-accept-ref.png')
await wait(2)

// 上传按钮图标化后计数进了 aria-label（「上传参考图（1／5）」），故按前缀匹配。
// （旧脚本还 OR 了一个 `参考图已上传` 的文本探针，但那句文案在源码里并不存在 —— 恒为 false 的死判据，已删）
const refUploaded = await js(String.raw`(() => [...document.querySelectorAll('.ws-panel button')].some(b => (b.getAttribute('aria-label') || '').startsWith('上传参考图（1')))()`)
cliLog('refUploaded=' + refUploaded)

// 提交 2 张生成
await js(String.raw`(() => {
  const ta = document.querySelector('.ws-panel textarea')
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, '验收：基于参考图的生成')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  // RAC NumberField 真正入 DOM 的输入框是 type="text"（带 inputMode）—— react-aria 另建了一个
  // **游离**（未插入 DOM）的 type="number" 元素做原生 min/max 校验，所以页面上 input[type="number"] 恒为空。
  // 标签实际文案带范围（「张数（1–12 张）」），按 aria-label 前缀取更稳
  const num = document.querySelector('.ws-panel input[aria-label^="张数"]')
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(num, '2')
  num.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)
await js(String.raw`(() => {
  // 文案带张数（「生成（N 张）」），故用前缀匹配；找不到要显式报错，否则 .click() 抛的 TypeError 看不出原因
  const btn = [...document.querySelectorAll('.ws-panel button')].find(b => b.innerText.trim().startsWith('生成'))
  if (!btn) throw new Error('「生成」按钮未找到')
  btn.click(); return true
})()`)
let imgs = 0
for (let i = 0; i < 90; i++) {
  await wait(2)
  imgs = await js(String.raw`document.querySelectorAll('.canvas-img-card img').length`)
  if (imgs >= 3) break // 1 参考图 + 2 生成
}
cliLog('canvas images=' + imgs)
if (imgs < 3) throw new Error('参考图+生成图应 ≥3，实际 ' + imgs)
// 消息应记录参考图 ID（真实图生图 edits 输入）
const topicId = JSON.parse(await browserFetch('/api/topics')).topics[0].id
const detail = JSON.parse(await browserFetch('/api/topics/' + topicId))
const lastMsg = detail.messages[detail.messages.length - 1] || {}
const refInMsg = (lastMsg.referenceIds || []).length
cliLog('message referenceIds=' + refInMsg)
if (refInMsg < 1) throw new Error('消息未记录参考图')
EOF
echo "[accept] C ✅"

# ---------- D：取消退额守恒 ----------
echo "[accept] D: cancel with refund conservation"
ego-browser nodejs <<'EOF'
const task = await useOrCreateTaskSpace('motif acceptance')
await ensureRealTab()
const before = await js(String.raw`(() => Number((document.querySelector('.ws-nav').innerText.match(/(?:余额\s+)?(\d+)\s+张/) || [])[1]))()`)
const beforeImgs = await js(String.raw`document.querySelectorAll('.canvas-img-card img').length`)
cliLog(`before: credits=${before} imgs=${beforeImgs}`)

// 提交 2 张（真实网关按张计费，压到最小）
await js(String.raw`(() => {
  const num = document.querySelector('.ws-panel input[aria-label^="张数"]')
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(num, '2')
  num.dispatchEvent(new Event('input', { bubbles: true }))
  const ta = document.querySelector('.ws-panel textarea')
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, '验收：取消退额')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)
await js(String.raw`(() => {
  // 文案带张数（「生成（N 张）」），故用前缀匹配；找不到要显式报错，否则 .click() 抛的 TypeError 看不出原因
  const btn = [...document.querySelectorAll('.ws-panel button')].find(b => b.innerText.trim().startsWith('生成'))
  if (!btn) throw new Error('「生成」按钮未找到')
  btn.click(); return true
})()`)
await wait(1)

// 尽快点击取消
const cancelClicked = await js(String.raw`(() => {
  const btn = [...document.querySelectorAll('.ws-panel button')].find(b => b.innerText.trim() === '取消生成')
  if (btn) { btn.click(); return true }
  return false
})()`)
cliLog('cancel clicked=' + cancelClicked)

// 等任务回到空闲（真实网关最长约 1–2 分钟）
let idle = false
for (let i = 0; i < 60; i++) {
  await wait(2)
  idle = await js(String.raw`(() => document.body.innerText.includes('空闲'))()`)
  if (idle) break
}
if (!idle) throw new Error('任务未回到空闲态')
await wait(2)

const after = await js(String.raw`(() => Number((document.querySelector('.ws-nav').innerText.match(/(?:余额\s+)?(\d+)\s+张/) || [])[1]))()`)
const afterImgs = await js(String.raw`document.querySelectorAll('.canvas-img-card img').length`)
const newImgs = afterImgs - beforeImgs
cliLog(`after: credits=${after} newImgs=${newImgs} conservation=${after}+${newImgs}==${before}`)
// 守恒：余额 + 新增图片数 == 提交前余额（2 张的费用要么变成图、要么退回）
if (after + newImgs !== before) throw new Error(`额度不守恒: ${after}+${newImgs} != ${before}`)
// 若走了取消路径，应有退回 toast（HeroUI toast 的 role 由 react-aria useToast 给出，与 run.sh 同口径）
// 注意 role="alertdialog" 有两个来源（react-aria 的每个 toast + HeroUI AlertDialog 删除确认框），
// 故按内容过滤，别取 DOM 首个
const refundToast = await js(String.raw`(() => { const t = [...document.querySelectorAll('[role="alertdialog"]')].find(x => x.innerText.includes('额度') || x.innerText.includes('退回')); return t ? t.innerText : null })()`)
cliLog('refundToast=' + refundToast)
EOF
echo "[accept] D ✅"

# ---------- E：个人资料 + 修改密码 + 错误路径 ----------
echo "[accept] E: profile + password + error paths"
ego-browser nodejs <<'EOF'
const E2E = JSON.parse((await import('node:fs')).readFileSync('/tmp/motif-accept-env.json', 'utf8'))
const PASSWORD = E2E.password
const NEW_PASSWORD = E2E.newPassword
const task = await useOrCreateTaskSpace('motif acceptance')
await ensureRealTab()

// 打开账号菜单 → 个人资料（资料 / 退出都收进了顶栏的下拉）
await js(String.raw`(() => {
  const b = document.querySelector('.ws-nav button[aria-label="账号菜单"]')
  if (!b) throw new Error('账号菜单未找到')
  b.click(); return true
})()`)
await wait(1)
await js(String.raw`(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === '个人资料')
  if (!b) throw new Error('「个人资料」菜单项未找到')
  b.click(); return true
})()`)
await wait(1)
const opened = await js(String.raw`(() => !!document.querySelector('[role="dialog"][aria-label="个人资料"]'))()`)
if (!opened) throw new Error('个人资料弹窗未打开')

// 改昵称
await js(String.raw`(() => {
  const m = document.querySelector('[role="dialog"][aria-label="个人资料"]')
  const input = m.querySelector('[data-testid="profile-name"]')
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '首席验收官')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  ;[...m.querySelectorAll('button')].find(b => b.innerText.trim() === '保存昵称').click()
  return true
})()`)
await wait(2)
const renamed = await js(String.raw`(() => document.body.innerText.includes('首席验收官'))()`)
cliLog('renamed=' + renamed)
if (!renamed) throw new Error('昵称修改未生效')

// 重新打开资料弹窗，错误旧密码 → 报错提示
await js(String.raw`(() => {
  document.querySelector('.ws-nav button[aria-label="账号菜单"]').click(); return true
})()`)
await wait(1)
await js(String.raw`(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === '个人资料')
  b.click(); return true
})()`)
await wait(1)
await js(String.raw`(() => {
  const m = document.querySelector('[role="dialog"][aria-label="个人资料"]')
  const setVal = (sel, v) => {
    const el = m.querySelector(sel)
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  setVal('[data-testid="profile-old-password"]', 'wrong-old-pw')
  setVal('[data-testid="profile-new-password"]', '${NEW_PASSWORD}')
  ;[...m.querySelectorAll('button')].find(b => b.innerText.trim() === '修改密码').click()
  return true
})()`)
await wait(2)
const errShown = await js(String.raw`(() => {
  const m = document.querySelector('[role="dialog"][aria-label="个人资料"]')
  return !!m.querySelector('[data-testid="profile-error"]')
})()`)
cliLog('wrong-old-password error shown=' + errShown)
if (!errShown) throw new Error('错误旧密码未提示')

// 正确旧密码 → 修改成功（弹窗自动关闭 + toast）
await js(String.raw`(() => {
  const m = document.querySelector('[role="dialog"][aria-label="个人资料"]')
  const setVal = (sel, v) => {
    const el = m.querySelector(sel)
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  setVal('[data-testid="profile-old-password"]', '${PASSWORD}')
  setVal('[data-testid="profile-new-password"]', '${NEW_PASSWORD}')
  ;[...m.querySelectorAll('button')].find(b => b.innerText.trim() === '修改密码').click()
  return true
})()`)
await wait(2)
const pwOk = await js(String.raw`(() => document.body.innerText.includes('密码已修改'))()`)
cliLog('password changed=' + pwOk)
if (!pwOk) throw new Error('修改密码未成功')

// 登出 → 旧密码登录应失败 → 新密码登录成功
await js(String.raw`(() => {
  document.querySelector('.ws-nav button[aria-label="账号菜单"]').click(); return true
})()`)
await wait(1)
await js(String.raw`(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === '退出')
  if (!b) throw new Error('「退出」菜单项未找到')
  b.click(); return true
})()`)
await wait(3)
// 登出后落地页**不会**自动弹登录框：点导航「立即生成」打开（与 run.sh Round 5 同口径）
await js(String.raw`(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === '立即生成')
  if (!b) throw new Error('「立即生成」入口未找到')
  b.click(); return true
})()`)
await wait(1)
await js(String.raw`(() => {
  const email = '${E2E.email}'
  const setVal = (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  // 登录表单字段顺序：邮箱 / 密码
  const inputs = [...document.querySelectorAll('#auth-form input')]
  setVal(inputs[0], email)
  setVal(inputs[1], '${PASSWORD}')
  return true
})()`)
await js(String.raw`(() => { document.querySelector('button[form="auth-form"]').click(); return true })()`)
await wait(3)
const oldRejected = await js(String.raw`(() => !!document.querySelector('[data-testid="auth-error"]'))()`)
cliLog('old password rejected=' + oldRejected)
if (!oldRejected) throw new Error('旧密码未被拒绝')

await js(String.raw`(() => {
  const email = '${E2E.email}'
  const setVal = (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const inputs = [...document.querySelectorAll('#auth-form input')]
  setVal(inputs[0], email)
  setVal(inputs[1], '${NEW_PASSWORD}')
  return true
})()`)
await js(String.raw`(() => { document.querySelector('button[form="auth-form"]').click(); return true })()`)
await wait(4)
const relogin = await js(String.raw`(() => !!document.querySelector('.ws-shell'))()`)
cliLog('new password login=' + relogin)
if (!relogin) throw new Error('新密码登录失败')
EOF
echo "[accept] E ✅"

# ---------- F：画布交互（拖拽/选中/工具栏/@引用/整理/灯箱/删除）----------
# ⚠️ 取「图片卡片」的选择器一律写成 `.canvas-img-card:not(.canvas-skeleton-card)`：
# 骨架槽（#88）也挂 `.canvas-img-card`（只为复用绝对定位），且 DOM 里排在图片之前，
# 裸 `.canvas-img-card` 会取到 `pointer-events:none` 的骨架（拖拽无位移、计数虚高）。
echo "[accept] F: canvas interactions"
ego-browser nodejs <<'EOF'
const task = await useOrCreateTaskSpace('motif acceptance')
await ensureRealTab()

// 定位第一张图片卡片的视口中心
const center = await js(String.raw`(() => {
  const card = document.querySelector('.canvas-img-card:not(.canvas-skeleton-card)')
  if (!card) throw new Error('画布上没有图片卡片')
  const r = card.getBoundingClientRect()
  return { cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2), left: Math.round(r.x), top: Math.round(r.y), w: Math.round(r.width) }
})()`)
cliLog('card center: ' + JSON.stringify(center))

// 记录拖拽前的世界坐标（left/top 样式值）
const posBefore = await js(String.raw`(() => {
  const card = document.querySelector('.canvas-img-card:not(.canvas-skeleton-card)')
  return { left: card.style.left, top: card.style.top }
})()`)

// 拖拽图片 → 自由移动
await dragMouse([[center.cx, center.cy], [center.cx + 160, center.cy + 90]], { label: 'drag canvas image' })
await wait(1)
const posAfter = await js(String.raw`(() => {
  const card = document.querySelector('.canvas-img-card:not(.canvas-skeleton-card)')
  return { left: card.style.left, top: card.style.top }
})()`)
cliLog(`drag: ${JSON.stringify(posBefore)} → ${JSON.stringify(posAfter)}`)
if (posAfter.left === posBefore.left) throw new Error('拖拽后图片位置未变化')

// 点击图片 → 选中 + 浮动工具栏出现
await dragMouse([[center.cx + 160, center.cy + 90], [center.cx + 160, center.cy + 90]], { label: 'noop hold' })
await click([center.cx + 160, center.cy + 90], { label: 'select image' })
await wait(1)
const sel = await js(String.raw`(() => ({
  // 画布状态读数（原「画布左上角 pill」，现并入底部工具栏的 .canvas-status）
  pill: (document.querySelector('.canvas-status') || {}).innerText?.replace(/\n/g, ' ') || null,
  toolbar: !!document.querySelector('.canvas-toolbar'),
  // 浮动工具栏的按钮只有 aria-label、从来没有 title（改用 title 会让这里恒为空数组 → 下面必 throw）
  toolArias: [...document.querySelectorAll('.canvas-toolbar [aria-label]')].map(b => b.getAttribute('aria-label'))
}))()`)
cliLog('selection: ' + JSON.stringify(sel))
if (!sel.pill || !sel.pill.includes('已选 1')) throw new Error('选中态未出现: ' + sel.pill)
if (!sel.toolbar) throw new Error('浮动工具栏未出现')
if (!sel.toolArias.includes('加入参考图，并把编号写进提示词') || !sel.toolArias.includes('删除所选图片')) throw new Error('工具栏按钮不全: ' + JSON.stringify(sel.toolArias))

// @ 引用 → 提示词写入 #编号 且参考图计数 +1
await js(String.raw`(() => {
  const b = [...document.querySelectorAll('.canvas-toolbar button')].find(x => x.getAttribute('aria-label')?.includes('参考图'))
  b.click(); return true
})()`)
await wait(1)
const refState = await js(String.raw`(() => ({
  promptHasSerial: /#\d{3}/.test(document.querySelector('.ws-panel textarea').value),
  refBtn: [...document.querySelectorAll('.ws-panel button')].find(b => (b.getAttribute('aria-label') || '').startsWith('上传参考图'))?.getAttribute('aria-label') || null
}))()`)
cliLog('reference: ' + JSON.stringify(refState))
if (!refState.promptHasSerial) throw new Error('@ 引用未把编号写入提示词')

// 双击图片 → 灯箱；Esc 关闭（灯箱已改用 HeroUI Modal 容器承载，锚点是 dialog 的 aria-label）
await doubleClick([center.cx + 160, center.cy + 90], { label: 'open lightbox' })
await wait(1)
const lightbox = await js(String.raw`(() => !!document.querySelector('[role="dialog"][aria-label="图片预览"]'))()`)
cliLog('lightbox open=' + lightbox)
if (!lightbox) throw new Error('双击灯箱未打开')
await pressKey('Escape')
await wait(1)
const lightboxClosed = await js(String.raw`(() => !document.querySelector('[role="dialog"][aria-label="图片预览"]'))()`)
if (!lightboxClosed) throw new Error('Esc 未关闭灯箱')

// 整理布局 → 位置吸附回网格
const arrangeBtn = await js(String.raw`(() => {
  const b = document.querySelector('button[aria-label="整理布局"]')
  const r = b.getBoundingClientRect()
  return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]
})()`)
await click(arrangeBtn, { label: 'arrange layout' })
await wait(1.5)
const posArranged = await js(String.raw`(() => {
  const card = document.querySelector('.canvas-img-card:not(.canvas-skeleton-card)')
  return { left: card.style.left, top: card.style.top }
})()`)
cliLog('arranged: ' + JSON.stringify(posArranged))
if (posArranged.left === posAfter.left && posArranged.top === posAfter.top) throw new Error('整理布局未吸附网格')

// 删除选中图片 → 画布减少一张
const countBefore = await js(String.raw`(() => document.querySelectorAll('.canvas-img-card:not(.canvas-skeleton-card)').length)()`)
// 重新选中并删除
const c2 = await js(String.raw`(() => {
  const card = document.querySelector('.canvas-img-card:not(.canvas-skeleton-card)')
  const r = card.getBoundingClientRect()
  return { cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) }
})()`)
await click([c2.cx, c2.cy], { label: 'select for delete' })
await wait(1)
await js(String.raw`(() => {
  const b = [...document.querySelectorAll('.canvas-toolbar button')].find(x => x.getAttribute('aria-label') === '删除所选图片')
  b.click(); return true
})()`)
await wait(1)
// 确认对话框（HeroUI AlertDialog → role="alertdialog"）：校验文案要点后点击「删除」
const confirmModal = await js(String.raw`(() => {
  const m = [...document.querySelectorAll('[role="alertdialog"]')].find(x => x.innerText.includes('删除图片'))
  if (!m) return { open: false }
  return { open: true, hasCancel: [...m.querySelectorAll('button')].some(b => b.innerText.trim() === '取消'), serialNote: m.innerText.includes('编号') }
})()`)
cliLog('confirm modal: ' + JSON.stringify(confirmModal))
if (!confirmModal.open) throw new Error('删除确认框未出现')
if (!confirmModal.serialNote) throw new Error('确认框缺少编号不变说明')
await js(String.raw`(() => {
  const m = [...document.querySelectorAll('[role="alertdialog"]')].find(x => x.innerText.includes('删除图片'))
  ;[...m.querySelectorAll('button')].find(b => b.innerText.trim() === '删除').click()
  return true
})()`)
await wait(2)
const countAfter = await js(String.raw`(() => document.querySelectorAll('.canvas-img-card:not(.canvas-skeleton-card)').length)()`)
cliLog(`delete: ${countBefore} → ${countAfter}`)
if (countAfter !== countBefore - 1) throw new Error('删除未生效')
EOF
echo "[accept] F ✅"

# ---------- G：#88 骨架槽位（提交即预占：骨架数 == N − 已出图数）----------
echo "[accept] G: skeleton slots (#88)"
ego-browser nodejs <<'EOF'
const task = await useOrCreateTaskSpace('motif acceptance')
await ensureRealTab()

// 新建任务：骨架判据是「本轮 N − 已出图数」，存量图会干扰计数，故从零画布开始
await js(String.raw`(() => {
  const b = document.querySelector('button[aria-label="新任务"]')
  if (!b) throw new Error('「新任务」按钮未找到')
  b.click(); return true
})()`)
await wait(2)

// 提交 4 张
await js(String.raw`(() => {
  const ta = document.querySelector('.ws-panel textarea')
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, '验收：#88 骨架槽位')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  const num = document.querySelector('.ws-panel input[aria-label^="张数"]')
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(num, '4')
  num.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)
await js(String.raw`(() => {
  // 文案带张数（「生成（N 张）」），故用前缀匹配；找不到要显式报错，否则 .click() 抛的 TypeError 看不出原因
  const btn = [...document.querySelectorAll('.ws-panel button')].find(b => b.innerText.trim().startsWith('生成'))
  if (!btn) throw new Error('「生成」按钮未找到')
  btn.click(); return true
})()`)

// 提交后轮询「骨架数 / 已出图数」，在骨架存在的瞬间断言 骨架数 + 已出图数 == N。
// 骨架是瞬时态（出图快时可能一次都抓不到），故仅在「观察到骨架」时断言；从未观察到则跳过（记日志）。
// 骨架 = 画布上唯一带 aria-busy="true" 的卡片；图片卡计数用 `.canvas-img-card img`（骨架无 <img>）。
const N = 4
let seen = null
let ok = false
for (let i = 0; i < 20; i++) {
  await wait(1)
  const snap = await js(String.raw`(() => ({
    sk: document.querySelectorAll('.canvas-img-card[aria-busy="true"]').length,
    imgs: document.querySelectorAll('.canvas-img-card img').length,
  }))()`)
  if (snap.sk > 0) {
    seen = snap
    if (snap.sk + snap.imgs === N) { ok = true; break }
  }
}
cliLog('skeleton snapshot=' + JSON.stringify(seen) + ' ok=' + ok)
if (seen && !ok) throw new Error(`骨架数 + 已出图数 != ${N}: ${JSON.stringify(seen)}`)
if (!seen) cliLog('⚠️ 未捕获到骨架瞬间（生成过快），本条跳过')
EOF
echo "[accept] G ✅"

echo "[accept] 关闭任务空间"
ego-browser nodejs <<'EOF'
const task = await useOrCreateTaskSpace('motif acceptance')
const r = await completeTaskSpace(task.id, { keep: false })
cliLog('closed: ' + JSON.stringify(r))
EOF

echo ""
echo "[accept] 🎉 补充验收全部通过（A–G）"
