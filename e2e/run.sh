#!/usr/bin/env bash
#
# Motif E2E —— 基于 ego-browser 的端到端测试
# 覆盖：落地页渲染 → 注册（开发模式验证码）→ 工作台 → 提示词库取词出图 → 任务管理 → 充值 → 登出
#
# 用法：bash e2e/run.sh
#
# ⚠️ 本脚本直连真实生图网关并消耗额度；它从不在 CI 里跑，日常门禁是 typecheck + 单测。
#
# 跑之前建议先停掉 dev，但这**不是**硬性要求：16 起 dev 产物在 apps/web/.next/dev、
# 构建产物在 apps/web/.next/*，二者并存，实测 dev 与 `next build`、dev 与 `next start`
# 均可同时运行，没有互斥 lockfile。之所以仍建议停：本脚本在缺 .next/server 时会自己
# `pnpm build`，而 build 会重写 .next/*，此时若有别的进程正服务同一份产物会读到半成品；
# 且 dev 编译会与 e2e 抢 CPU / 内存。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEB_DIR="$ROOT/apps/web"
PORT=3210
BASE="http://127.0.0.1:$PORT"
export MOTIF_EXPOSE_DEV_CODE=1
export MOTIF_DATA_DIR="${MOTIF_DATA_DIR:-$WEB_DIR/.data-e2e}"

# 夹具密码（#98-3）：脚本里原本硬编码 3 处，改一处漏一处就会「注册用 A、登录用 B」。
# 只在 shell 侧声明一次，再经临时 env json 传进 heredoc —— heredoc 是 `<<'EOF'`（不做变量展开），
# 直接写 `$E2E_PASSWORD` 不会被替换。
# 取值须满足 D14 复杂度：≥8 位且同时含大写/小写字母、数字、符号。
E2E_PASSWORD='E2e-Secret-66'

cd "$WEB_DIR"

# 0. 若无构建产物则先构建。
# 判据用 .next/server 而不是 .next：16 里 dev 产物落在 .next/dev，跑过 dev 之后 .next 也存在，
# 拿 .next 当「已有构建产物」会误判，导致直接 next start 起不来。
if [ ! -d .next/server ]; then
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
printf '{"base":"%s","email":"%s","password":"%s"}\n' "$BASE" "$EMAIL" "$E2E_PASSWORD" > "$E2E_ENV_FILE"
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
  heroCta: text.includes('开始生成') && text.includes('立即生成'),
  features: text.includes('为什么选 Motif'),
  footer: text.includes('© 2026 Motif'),
  nav: text.includes('Motif') && text.includes('立即生成'),
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
const PASSWORD = E2E.password

// 落地页的登录/注册已弹窗化：先点底部「免费注册」把弹窗打开（直接进注册模式）
await js(String.raw`(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === '免费注册')
  if (!b) throw new Error('「免费注册」入口未找到')
  b.click()
  return true
})()`)
await wait(1)

// 确认已进注册模式（「免费注册」入口直接就是 register 模式）
await js(String.raw`(() => {
  if (document.body.innerText.includes('创建账号')) return 'already-register'
  throw new Error('注册表单未出现')
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
  const inputs = [...document.querySelectorAll('[role="dialog"] form input')]
  setVal(inputs[0], 'E2E 用户')           // 昵称
  setVal(inputs[1], email)                 // 邮箱
  setVal(inputs[2], 'MOTIF-E2E-CDK')     // 邀请码（不存在的邀请码应被忽略）
  setVal(inputs[3], code)                  // 验证码
  setVal(inputs[4], '${PASSWORD}')         // 密码（须满足 D14 复杂度：大写+小写+数字+符号，≥8 位）
  setVal(inputs[5], '${PASSWORD}')         // 确认密码
  return inputs.length
})()`
const filled = await js(fillScript)
if (filled < 6) throw new Error('注册表单字段不足: ' + filled)

await js(String.raw`(() => {
  // 主操作按钮在 Modal.Footer 里（不在 <form> 内），靠 form="auth-form" 关联 —— 故不能写成 form button[type="submit"]
  const b = [...document.querySelectorAll('[role="dialog"] button[type="submit"]')][0]
  b.click()
  return true
})()`)
await wait(4)

// 注册成功后应进入工作台（空画布的任务显示新手引导，不再是模板画廊）
const ws = await js(String.raw`(() => ({
  shell: !!document.querySelector('.ws-shell'),
  guide: !!document.querySelector('[data-testid="canvas-empty-guide"]'),
  credits: (document.querySelector('.ws-nav').innerText.match(/(?:余额\s+)?(\d+)\s+张/) || [])[1] || null,
}))()`)
cliLog('WORKSPACE ' + JSON.stringify(ws))
if (!ws.shell || !ws.guide) throw new Error('注册后未进入工作台')
if (ws.credits !== '3') throw new Error('注册赠送额度应为 3，实际: ' + ws.credits)
EOF
echo "[e2e] Round 2 ✅"

# ---------- Round 3：提示词库取词 + 生成流程 ----------
echo "[e2e] Round 3: prompt library + generation"
ego-browser nodejs <<'EOF'
const task = await useOrCreateTaskSpace('motif e2e')
await ensureRealTab()

// 提示词库是表单侧提示词的唯一入口：空态引导底部按钮 → 弹窗 → 选「系统自带」一条
// 判据：**只填提示词**；张数与尺寸逐值不变（模板已并入「系统自带」源，不再联动张数/尺寸）
const readPanel = String.raw`(() => {
  const ta = document.querySelector('.ws-panel textarea')
  const num = document.querySelector('.ws-panel input[aria-label^="张数"]')
  // 尺寸控件 2026-09-21 起由单选组改为 Dropdown：触发件按钮带 aria-label="尺寸：<名>"，
  // 旧的 [role="radio"][data-selected="true"] 在 apps/web/src 已零命中（恒空 → 下面守卫必抛）
  const sizeBtn = document.querySelector('.ws-panel button[aria-label^="尺寸："]')
  return { promptLen: ta.value.length, count: num ? num.value : null, size: sizeBtn ? sizeBtn.getAttribute('aria-label').replace('尺寸：', '') : null }
})()`
const before = await js(readPanel)
cliLog('PANEL_BEFORE ' + JSON.stringify(before))
// 先确认两个控件真的取到了：否则下面「逐值不变」会在两边都是 null 时静默通过
if (before.count === null || before.size === null) throw new Error('张数/尺寸控件未找到')

const clicked = await js(String.raw`(() => {
  const guide = document.querySelector('[data-testid="canvas-empty-guide"]')
  if (!guide) throw new Error('空态引导未找到')
  const b = [...guide.querySelectorAll('button')].find(x => x.innerText.trim() === '打开提示词库')
  if (!b) throw new Error('「打开提示词库」按钮未找到')
  b.click()
  return '打开提示词库'
})()`)
cliLog('LIBRARY ' + clicked)
await wait(2)

// 选「系统自带」来源（TagGroup 里的 Tag，按文本定位）
await js(String.raw`(() => {
  const tag = [...document.querySelectorAll('[role="dialog"] *')]
    .find(x => x.children.length === 0 && x.textContent.trim() === '系统自带')
  if (!tag) throw new Error('「系统自带」来源未找到')
  tag.click()
  return true
})()`)
await wait(1)

// 点第一张卡片（卡片是带 aria-label 的真按钮）
const picked = await js(String.raw`(() => {
  const card = document.querySelector('[role="dialog"] [aria-label^="选用提示词："]')
  if (!card) throw new Error('提示词卡片未找到')
  const title = card.getAttribute('aria-label')
  card.click()
  return title
})()`)
cliLog('PICKED ' + picked)
await wait(1)

const after = await js(readPanel)
cliLog('PANEL_AFTER ' + JSON.stringify(after))
if (after.promptLen < 50) throw new Error('提示词未被填入: ' + after.promptLen)
if (after.count !== before.count) throw new Error('张数被联动改了: ' + before.count + ' → ' + after.count)
if (after.size !== before.size) throw new Error('尺寸被联动改了: ' + before.size + ' → ' + after.size)

// 改为 2 张（赠送额度 3，留余量）
// 用 CDP 插入文本：实测「设 value + 派 input」没能驱动它的 onChange（提交时仍是旧值）
await js(String.raw`(() => {
  const num = document.querySelector('.ws-panel input[aria-label^="张数"]')
  num.focus()
  num.select()
  return true
})()`)
await cdp('Input.insertText', { text: '2' })
await wait(0.5)
await js(String.raw`(() => {
  document.querySelector('.ws-panel input[aria-label^="张数"]').blur()
  return true
})()`)
await wait(1)
const countNow = await js(String.raw`(() => document.querySelector('.ws-panel input[aria-label^="张数"]').value)()`)
cliLog('COUNT_AFTER ' + countNow)
if (countNow !== '2') throw new Error('张数未改为 2: ' + countNow)

// 改为自包含提示词提交（模板提示词面向参考图场景，无参考图时模型可能拒绝）
await js(String.raw`(() => {
  const ta = document.querySelector('.ws-panel textarea')
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, '一只白色陶瓷马克杯放在木桌上，晨光斜射，蒸汽微起，产品摄影风格')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)

// 提交生成
await js(String.raw`(() => {
  const btn = [...document.querySelectorAll('.ws-panel button')].find(b => b.innerText.trim().startsWith('生成'))
  if (!btn) throw new Error('生成按钮未找到')
  btn.click()
  return true
})()`)
await wait(2)

const toast = await js(String.raw`(() => (document.querySelector('[role="alertdialog"]') || {}).innerText || null)()`)
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

// 图片真实可渲染。
// ⚠️ **必须轮询**，不能只查一次：CanvasStage 的图是 `<img loading="lazy">`，
// 「元素已插入」≠「已解码」—— 第二张常在同一轮里刚落 DOM、还没 load，
// 单发检查会偶发误报「存在未加载完成的图片」（2026-09-24 实测踩到，图本身是好的）。
// 超时则把每张的状态打出来，便于区分「没加载」与「真坏」。
let loaded = []
for (let i = 0; i < 20; i++) {
  loaded = await js(String.raw`(() => {
    const els = [...document.querySelectorAll('.canvas-img-card img')]
    return els.map(el => ({ ok: el.naturalWidth > 0, complete: el.complete, w: el.naturalWidth }))
  })()`)
  if (loaded.length > 0 && loaded.every((x) => x.ok)) break
  await wait(1)
}
cliLog('IMAGES_LOADED ' + JSON.stringify(loaded))
// 长度守卫：空数组的 every 恒真，会静默放行（虽然上一段已断言 imgs>=2，但别留这个洞）
if (loaded.length === 0 || !loaded.every((x) => x.ok)) {
  throw new Error('存在未加载完成的图片（若 complete=false 多为 lazy 未触发，非图片损坏）: ' + JSON.stringify(loaded))
}

// 额度应扣减为 1
const credits = await js(String.raw`(() => (document.querySelector('.ws-nav').innerText.match(/(?:余额\s+)?(\d+)\s+张/) || [])[1])()`)
cliLog('CREDITS_AFTER_GEN ' + credits)
if (credits !== '1') throw new Error('生成后额度应为 1，实际: ' + credits)
EOF
echo "[e2e] Round 3 ✅"

# ---------- Round 4：任务面板（重命名）+ 充值弹窗 ----------
echo "[e2e] Round 4: topic panel + billing"
ego-browser nodejs <<'EOF'
const task = await useOrCreateTaskSpace('motif e2e')
await ensureRealTab()
// 面板是否渲染取决于 useMediaQuery('(min-width: 1024px)')；每轮是独立 heredoc，视口覆盖未必延续，
// 故与 R1 同口径重设一次（幂等、无副作用），避免窄视口下面板不渲染导致下面的守卫失败
await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })

// 任务面板 2026-09-21 起由「点图标弹出的抽屉」升级为**常驻浮动面板**（宽屏默认展开），
// 故不再有「打开抽屉」这一步，锚点也换成面板本身的 aria-label
const panel = await js(String.raw`(() => {
  const open = !!document.querySelector('[aria-label="任务面板"]')
  return { open, items: document.querySelectorAll('.ws-topic-item').length, hasInvite: document.body.innerText.includes('邀请好友') }
})()`)
cliLog('PANEL ' + JSON.stringify(panel))
if (!panel.open || panel.items < 1) throw new Error('任务面板未展开或为空')

// 重命名任务
await js(String.raw`(() => {
  const item = document.querySelector('.ws-topic-item')
  const btn = [...item.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === '重命名任务')
  btn.click()
  return true
})()`)
await wait(1)
// 同样走 CDP 插入文本（理由见 Round 3 张数那处）
await js(String.raw`(() => {
  const input = document.querySelector('.ws-topic-item input')
  input.focus()
  input.select()
  return true
})()`)
await cdp('Input.insertText', { text: 'E2E 马克杯套图' })
await wait(0.5)
await js(String.raw`(() => {
  document.querySelector('.ws-topic-item input').blur()
  return true
})()`)
await wait(1)
await js(String.raw`(() => {
  const b = [...document.querySelectorAll('.ws-topic-item button')].find(x => x.innerText.trim() === '保存')
  b.click()
  return true
})()`)
await wait(2)
const renamed = await js(String.raw`(() => document.body.innerText.includes('E2E 马克杯套图'))()`)
cliLog('RENAMED ' + renamed)
if (!renamed) throw new Error('任务重命名未生效')

// 打开充值弹窗（余额与充值已合并成顶栏一个按钮：无「充值」文字，靠 aria-label 前缀定位）
await js(String.raw`(() => {
  const b = document.querySelector('.ws-nav button[aria-label^="余额"]')
  if (!b) throw new Error('余额/充值入口未找到')
  b.click()
  return true
})()`)
await wait(2)
const billing = await js(String.raw`(() => {
  const m = document.querySelector('[role="dialog"][aria-label="充值额度"]')
  // 套餐卡片是弹窗里不带 aria-label 的按钮（关闭按钮带 aria-label="关闭"）
  const pkgs = m ? [...m.querySelectorAll('button')].filter(b => !b.getAttribute('aria-label')) : []
  return { open: !!m, packages: pkgs.length, cdk: m ? m.innerText.includes('CDK') : false }
})()`)
cliLog('BILLING ' + JSON.stringify(billing))
if (!billing.open || billing.packages < 4 || !billing.cdk) throw new Error('充值弹窗内容不完整')

// 购买第一档（50 张）→ 模拟收银台自动支付 → 额度 1 + 50 = 51
await js(String.raw`(() => {
  const m = document.querySelector('[role="dialog"][aria-label="充值额度"]')
  ;[...m.querySelectorAll('button')].filter(b => !b.getAttribute('aria-label'))[0].click()
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
  const m = document.querySelector('[role="dialog"] [aria-label="关闭"]')
  if (m) m.click()
  return true
})()`)
await wait(1)
// 「退出」已收进顶栏的账号菜单（Popover 内容经 Portal 挂到 body，不在 .ws-nav 内），故两步走
await js(String.raw`(() => {
  const b = document.querySelector('.ws-nav button[aria-label="账号菜单"]')
  if (!b) throw new Error('账号菜单未找到')
  b.click()
  return true
})()`)
await wait(1)
await js(String.raw`(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === '退出')
  if (!b) throw new Error('「退出」菜单项未找到')
  b.click()
  return true
})()`)
await wait(3)
const landing = await js(String.raw`(() => ({
  hero: document.body.innerText.includes('一张参考图'),
  cta: document.body.innerText.includes('开始生成'),
}))()`)
cliLog('LOGOUT ' + JSON.stringify(landing))
if (!landing.hero || !landing.cta) throw new Error('登出后未回到落地页')
EOF
echo "[e2e] Round 4 ✅"

# ---------- Round 5：登录回归 + 收尾 ----------
echo "[e2e] Round 5: login again + cleanup"
ego-browser nodejs <<'EOF'
const E2E = JSON.parse((await import('node:fs')).readFileSync('/tmp/motif-e2e-env.json', 'utf8'))
const task = await useOrCreateTaskSpace('motif e2e')
await ensureRealTab()

// 落地页登录已弹窗化：先点导航「立即生成」打开弹窗
await js(String.raw`(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === '立即生成')
  if (!b) throw new Error('「立即生成」入口未找到')
  b.click()
  return true
})()`)
await wait(1)

// 用刚注册的账号再次登录
const EMAIL = E2E.email
const PASSWORD = E2E.password
await js(String.raw`(() => {
  const email = '${EMAIL}'
  const setVal = (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const inputs = [...document.querySelectorAll('[role="dialog"] form input')]
  setVal(inputs[0], email)
  setVal(inputs[1], '${PASSWORD}')
  return true
})()`)
await js(String.raw`(() => {
  [...document.querySelectorAll('[role="dialog"] button[type="submit"]')][0].click()
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
