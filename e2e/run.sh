#!/usr/bin/env bash
#
# Motif E2E —— 基于 ego-browser 的端到端测试
# 覆盖：落地页渲染 → 注册（开发模式验证码）→ 工作台 → 模板出图 → 任务管理 → 充值 → 登出
#
# 用法：bash e2e/run.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEB_DIR="$ROOT/apps/web"
PORT=3210
BASE="http://127.0.0.1:$PORT"
export MOTIF_EXPOSE_DEV_CODE=1
export MOTIF_DATA_DIR="${MOTIF_DATA_DIR:-$WEB_DIR/.data-e2e}"

cd "$WEB_DIR"

# 0. 若无构建产物则先构建
if [ ! -d .next ]; then
  echo "[e2e] building..."
  pnpm build
fi

# 1. 清理端口与数据，启动全新生产服务
lsof -ti :"$PORT" 2>/dev/null | xargs kill -9 2>/dev/null || true
rm -rf "$MOTIF_DATA_DIR"
mkdir -p "$MOTIF_DATA_DIR"
echo "[e2e] starting server on :$PORT (data: $MOTIF_DATA_DIR)"
pnpm exec next start -p "$PORT" > /tmp/motif-e2e-server.log 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT

for i in $(seq 1 30); do
  if curl -s -o /dev/null "$BASE/api/billing/packages"; then break; fi
  sleep 1
done
curl -s -o /dev/null -w "[e2e] server ready: HTTP %{http_code}\n" "$BASE/api/billing/packages"

# 2. 生成随机测试账号（ego-browser heredoc 不继承 shell env，改走临时文件）
EMAIL="e2e-$(date +%s)-$RANDOM@test.dev"
E2E_ENV_FILE=/tmp/motif-e2e-env.json
printf '{"base":"%s","email":"%s"}\n' "$BASE" "$EMAIL" > "$E2E_ENV_FILE"
echo "[e2e] test account: $EMAIL"

fail() { echo "[e2e] ❌ FAIL: $1"; exit 1; }

# ---------- Round 1：落地页渲染 ----------
echo "[e2e] Round 1: landing page"
ego-browser nodejs <<'EOF'
const E2E = JSON.parse((await import('node:fs')).readFileSync('/tmp/motif-e2e-env.json', 'utf8'))
const task = await useOrCreateTaskSpace('motif e2e')
await openOrReuseTab(E2E.base + '/', { wait: true, timeout: 30 })
// 强制刷新，保证落地页处于初始（登录）模式，不受上轮残留状态影响
await gotoAndWait(E2E.base + '/', { timeout: 30 })
await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
await wait(1)
const text = await js(String.raw`document.body.innerText`)
const checks = {
  hero: text.includes('一张参考图'),
  authCard: text.includes('欢迎回来') || text.includes('创建账号'),
  features: text.includes('为什么选 Motif'),
  footer: text.includes('© 2026 motif'),
  nav: text.includes('案例一览') && text.includes('核心能力'),
}
cliLog('LANDING_CHECKS ' + JSON.stringify(checks))
if (Object.values(checks).some(v => !v)) throw new Error('landing page missing sections: ' + JSON.stringify(checks))
EOF
echo "[e2e] Round 1 ✅"

# ---------- Round 2：注册流程（开发模式验证码直出） ----------
echo "[e2e] Round 2: register"
ego-browser nodejs <<'EOF'
const E2E = JSON.parse((await import('node:fs')).readFileSync('/tmp/motif-e2e-env.json', 'utf8'))
const task = await useOrCreateTaskSpace('motif e2e')
await ensureRealTab()
const EMAIL = E2E.email

// 切到注册表单（若已在注册模式则直接继续）
await js(String.raw`(() => {
  const b = [...document.querySelectorAll('form button, #auth button')].find(x => x.innerText.trim() === '注册账号')
  if (b) { b.click(); return 'switched' }
  if (document.body.innerText.includes('创建账号')) return 'already-register'
  throw new Error('注册入口未找到')
})()`)
await wait(1)

// 预取验证码（开发模式接口直出）
const { devCode } = JSON.parse(await browserFetch('/api/auth/register/send-code', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL }),
}))
if (!devCode) throw new Error('devCode 未返回')
cliLog('DEV_CODE ok')

// 填表并提交
const fillScript = String.raw`(() => {
  const email = '${EMAIL}'
  const code = '${devCode}'
  const setVal = (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const inputs = [...document.querySelectorAll('#auth form input')]
  setVal(inputs[0], 'E2E 用户')           // 昵称
  setVal(inputs[1], email)                 // 邮箱
  setVal(inputs[2], 'MOTIF-E2E-CDK')     // 邀请码（不存在的邀请码应被忽略）
  setVal(inputs[3], code)                  // 验证码
  setVal(inputs[4], 'e2e-secret-66')       // 密码
  setVal(inputs[5], 'e2e-secret-66')       // 确认密码
  return inputs.length
})()`
const filled = await js(fillScript)
if (filled < 6) throw new Error('注册表单字段不足: ' + filled)

await js(String.raw`(() => {
  const b = [...document.querySelectorAll('#auth form button[type="submit"]')][0]
  b.click()
  return true
})()`)
await wait(4)

// 注册成功后应进入工作台
const ws = await js(String.raw`(() => ({
  shell: !!document.querySelector('.ws-shell'),
  gallery: document.body.innerText.includes('选一个模板，成套出图'),
  credits: (document.querySelector('.ws-nav').innerText.match(/(?:余额\s+)?(\d+)\s+张/) || [])[1] || null,
}))()`)
cliLog('WORKSPACE ' + JSON.stringify(ws))
if (!ws.shell || !ws.gallery) throw new Error('注册后未进入工作台')
if (ws.credits !== '3') throw new Error('注册赠送额度应为 3，实际: ' + ws.credits)
EOF
echo "[e2e] Round 2 ✅"

# ---------- Round 3：模板生成流程 ----------
echo "[e2e] Round 3: template generation"
ego-browser nodejs <<'EOF'
const task = await useOrCreateTaskSpace('motif e2e')
await ensureRealTab()

// 点击第一个模板卡
const clicked = await js(String.raw`(() => {
  const card = [...document.querySelectorAll('.tpl-card')][0]
  if (!card) throw new Error('模板卡未找到')
  const title = card.querySelector('.tpl-card-title').innerText
  card.click()
  return title
})()`)
cliLog('TEMPLATE ' + clicked)
await wait(1)

// 断言模板写入了提示词 / 张数 / 尺寸
const panel = await js(String.raw`(() => {
  const ta = document.querySelector('.ws-panel textarea')
  const num = document.querySelector('.ws-panel input[type="number"]')
  const active = document.querySelector('.ws-size-chip[data-active="true"]')
  return { promptLen: ta.value.length, count: num.value, size: active ? active.innerText.split('\n')[0] : null }
})()`)
cliLog('PANEL ' + JSON.stringify(panel))
if (panel.promptLen < 50) throw new Error('模板提示词未写入')
if (panel.count !== '8') throw new Error('模板张数未写入: ' + panel.count)

// 改为 2 张（赠送额度 3，留余量）
await js(String.raw`(() => {
  const num = document.querySelector('.ws-panel input[type="number"]')
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(num, '2')
  num.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)

// 改为自包含提示词提交（模板提示词面向参考图场景，无参考图时模型可能拒绝）
await js(String.raw`(() => {
  const ta = document.querySelector('.ws-panel textarea')
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, '一只白色陶瓷马克杯放在木桌上，晨光斜射，蒸汽微起，产品摄影风格')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)

// 提交生成
await js(String.raw`(() => {
  const btn = [...document.querySelectorAll('.ws-panel button')].find(b => b.innerText.trim() === '生成')
  if (!btn) throw new Error('生成按钮未找到')
  btn.click()
  return true
})()`)
await wait(2)

const toast = await js(String.raw`(() => (document.querySelector('.ws-toast') || {}).innerText || null)()`)
cliLog('TOAST ' + toast)
if (!toast || !toast.includes('队列')) throw new Error('生成提交 toast 未出现: ' + toast)

// 轮询画布直到 2 张图出现（真实网关串行生成，最长 4 分钟）
let imgs = 0
for (let i = 0; i < 120; i++) {
  await wait(2)
  imgs = await js(String.raw`document.querySelectorAll('.canvas-img-card img').length`)
  if (imgs >= 2) break
}
cliLog('CANVAS_IMGS ' + imgs)
if (imgs < 2) throw new Error('生成图片数量不足: ' + imgs)

// 图片真实可渲染
const loaded = await js(String.raw`(() => {
  const els = [...document.querySelectorAll('.canvas-img-card img')]
  return els.map(el => el.naturalWidth > 0)
})()`)
if (!loaded.every(Boolean)) throw new Error('存在未加载完成的图片')
cliLog('IMAGES_LOADED ' + JSON.stringify(loaded))

// 额度应扣减为 1
const credits = await js(String.raw`(() => (document.querySelector('.ws-nav').innerText.match(/(?:余额\s+)?(\d+)\s+张/) || [])[1])()`)
cliLog('CREDITS_AFTER_GEN ' + credits)
if (credits !== '1') throw new Error('生成后额度应为 1，实际: ' + credits)
EOF
echo "[e2e] Round 3 ✅"

# ---------- Round 4：任务抽屉（重命名）+ 充值弹窗 ----------
echo "[e2e] Round 4: task drawer + billing"
ego-browser nodejs <<'EOF'
const task = await useOrCreateTaskSpace('motif e2e')
await ensureRealTab()

// 打开任务抽屉
await js(String.raw`(() => {
  const b = [...document.querySelectorAll('.ws-nav button')].find(x => x.innerText.trim() === '任务')
  b.click()
  return true
})()`)
await wait(1)

const drawer = await js(String.raw`(() => {
  const d = document.querySelector('.ws-drawer')
  return { open: !!d, items: d ? d.querySelectorAll('.ws-topic-item').length : 0, hasInvite: d ? d.innerText.includes('邀请好友') : false }
})()`)
cliLog('DRAWER ' + JSON.stringify(drawer))
if (!drawer.open || drawer.items < 1) throw new Error('任务抽屉未打开或为空')

// 重命名任务
await js(String.raw`(() => {
  const item = document.querySelector('.ws-topic-item')
  const btn = [...item.querySelectorAll('button')].find(b => b.title === '重命名任务')
  btn.click()
  return true
})()`)
await wait(1)
await js(String.raw`(() => {
  const input = document.querySelector('.ws-topic-item input')
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'E2E 马克杯套图')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)
await js(String.raw`(() => {
  const b = [...document.querySelectorAll('.ws-topic-item button')].find(x => x.innerText.trim() === '保存')
  b.click()
  return true
})()`)
await wait(2)
const renamed = await js(String.raw`(() => document.body.innerText.includes('E2E 马克杯套图'))()`)
cliLog('RENAMED ' + renamed)
if (!renamed) throw new Error('任务重命名未生效')

// 关抽屉 → 打开充值弹窗
await js(String.raw`(() => {
  document.querySelector('.ws-drawer button[aria-label="关闭任务列表"]').click()
  return true
})()`)
await wait(1)
await js(String.raw`(() => {
  const b = [...document.querySelectorAll('.ws-nav button')].find(x => x.innerText.trim() === '充值')
  b.click()
  return true
})()`)
await wait(2)
const billing = await js(String.raw`(() => {
  const m = [...document.querySelectorAll('.ws-modal')].find(x => x.innerText.includes('充值额度'))
  return { open: !!m, packages: m ? [...m.querySelectorAll('.ws-size-chip')].length : 0, cdk: m ? m.innerText.includes('CDK') : false }
})()`)
cliLog('BILLING ' + JSON.stringify(billing))
if (!billing.open || billing.packages < 4 || !billing.cdk) throw new Error('充值弹窗内容不完整')

// 购买第一档（50 张）→ 模拟收银台自动支付 → 额度 1 + 50 = 51
await js(String.raw`(() => {
  const m = [...document.querySelectorAll('.ws-modal')].find(x => x.innerText.includes('充值额度'))
  m.querySelectorAll('.ws-size-chip')[0].click()
  return true
})()`)
let credits = null
for (let i = 0; i < 15; i++) {
  await wait(1)
  credits = await js(String.raw`(() => (document.querySelector('.ws-nav').innerText.match(/(?:余额\s+)?(\d+)\s+张/) || [])[1])()`)
  if (credits === '51') break
}
cliLog('CREDITS_AFTER_PAY ' + credits)
if (credits !== '51') throw new Error('充值后额度应为 51，实际: ' + credits)

// 登出 → 回到落地页
await js(String.raw`(() => {
  const m = document.querySelector('.ws-modal-mask')
  if (m) m.click()
  return true
})()`)
await wait(1)
await js(String.raw`(() => {
  const b = [...document.querySelectorAll('.ws-nav button')].find(x => x.innerText.includes('退出'))
  b.click()
  return true
})()`)
await wait(3)
const landing = await js(String.raw`(() => ({
  hero: document.body.innerText.includes('一张参考图'),
  auth: document.body.innerText.includes('欢迎回来'),
}))()`)
cliLog('LOGOUT ' + JSON.stringify(landing))
if (!landing.hero || !landing.auth) throw new Error('登出后未回到落地页')
EOF
echo "[e2e] Round 4 ✅"

# ---------- Round 5：登录回归 + 收尾 ----------
echo "[e2e] Round 5: login again + cleanup"
ego-browser nodejs <<'EOF'
const E2E = JSON.parse((await import('node:fs')).readFileSync('/tmp/motif-e2e-env.json', 'utf8'))
const task = await useOrCreateTaskSpace('motif e2e')
await ensureRealTab()

// 用刚注册的账号再次登录
const EMAIL = E2E.email
await js(String.raw`(() => {
  const email = '${EMAIL}'
  const setVal = (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const inputs = [...document.querySelectorAll('#auth form input')]
  setVal(inputs[0], email)
  setVal(inputs[1], 'e2e-secret-66')
  return true
})()`)
await js(String.raw`(() => {
  [...document.querySelectorAll('#auth form button[type="submit"]')][0].click()
  return true
})()`)
await wait(4)
const back = await js(String.raw`(() => ({
  shell: !!document.querySelector('.ws-shell'),
  canvasImgs: document.querySelectorAll('.canvas-img-card img').length,
}))()`)
cliLog('RELOGIN ' + JSON.stringify(back))
if (!back.shell) throw new Error('二次登录失败')
if (back.canvasImgs < 2) throw new Error('历史任务图片未保留')
cliLog('历史任务持久化 ✅')
EOF
echo "[e2e] Round 5 ✅"

echo "[e2e] 关闭任务空间"
ego-browser nodejs <<'EOF'
const task = await useOrCreateTaskSpace('motif e2e')
const r = await completeTaskSpace(task.id, { keep: false })
cliLog('task space closed: ' + JSON.stringify(r))
EOF

echo ""
echo "[e2e] 🎉 全部通过（5 rounds）"
