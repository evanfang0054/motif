#!/usr/bin/env bash
#
# Motif 补充验收 —— 覆盖 run.sh 之外的闭环：
#   CDK 兑换 · 取消退额守恒 · 个人资料改名 · 修改密码与错误路径 · 参考图参与生成
#
# 用法：bash e2e/acceptance.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEB_DIR="$ROOT/apps/web"
PORT=3220
BASE="http://127.0.0.1:$PORT"
export MOTIF_EXPOSE_DEV_CODE=1
export MOTIF_DATA_DIR="${MOTIF_DATA_DIR:-$WEB_DIR/.data-accept}"

cd "$WEB_DIR"

if [ ! -d .next ]; then
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
printf '{"base":"%s","email":"%s"}\n' "$BASE" "$EMAIL" > /tmp/motif-accept-env.json
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
const task = await useOrCreateTaskSpace('motif acceptance')
await openOrReuseTab(E2E.base + '/', { wait: true, timeout: 30 })
await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
await gotoAndWait(E2E.base + '/', { timeout: 30 })
await js(String.raw`(() => {
  const b = [...document.querySelectorAll('form button, #auth button')].find(x => x.innerText.trim() === '注册账号')
  if (b) b.click()
  return true
})()`)
await wait(1)
const { devCode } = JSON.parse(await browserFetch('/api/auth/register/send-code', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: E2E.email }),
}))
if (!devCode) throw new Error('devCode 未返回')
const script = String.raw`(() => {
  const email = '${E2E.email}'
  const code = '${devCode}'
  const setVal = (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const inputs = [...document.querySelectorAll('#auth form input')]
  setVal(inputs[0], '验收员')
  setVal(inputs[1], email)
  setVal(inputs[3], code)
  setVal(inputs[4], 'accept-66')
  setVal(inputs[5], 'accept-66')
  return inputs.length
})()`
await js(script)
await js(String.raw`(() => { [...document.querySelectorAll('#auth form button[type="submit"]')][0].click(); return true })()`)
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
await js(String.raw`(() => {
  const b = [...document.querySelectorAll('.ws-nav button')].find(x => x.innerText.trim() === '充值')
  b.click(); return true
})()`)
await wait(1)
await js(String.raw`(() => {
  const m = [...document.querySelectorAll('.ws-modal')].find(x => x.innerText.includes('充值额度'))
  const link = [...m.querySelectorAll('button')].find(x => x.innerText.includes('CDK'))
  link.click(); return true
})()`)
await wait(1)
await js(String.raw`(() => {
  const m = [...document.querySelectorAll('.ws-modal')].find(x => x.innerText.includes('CDK'))
  const input = m.querySelector('input')
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'motif-accept-20')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)
await js(String.raw`(() => {
  const m = [...document.querySelectorAll('.ws-modal')].find(x => x.innerText.includes('CDK'))
  const b = [...m.querySelectorAll('button')].find(x => x.innerText.trim() === '兑换')
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
// 兑换成功后弹窗已自动关闭；若仍在则手动关闭
await js(String.raw`(() => { const m = document.querySelector('.ws-modal-mask'); if (m) m.click(); return true })()`)
await wait(1)
EOF
echo "[accept] B ✅"

# ---------- C：参考图上传并参与生成 ----------
echo "[accept] C: reference image participates in generation"
ego-browser nodejs <<'EOF'
const task = await useOrCreateTaskSpace('motif acceptance')
await ensureRealTab()

// 新建任务并上传参考图（1×1 PNG）
await js(String.raw`(() => {
  // 图标化后该按钮无可见文字，改用 aria-label（2026-09-21）
  const b = document.querySelector('.ws-nav button[aria-label="新任务"]')
  b.click(); return true
})()`)
await wait(2)

// 上传参考图（prologue 已用 sharp 生成 512×512 PNG 到 /tmp/motif-accept-ref.png）
await uploadFile('.ws-panel input[type="file"]', '/tmp/motif-accept-ref.png')
await wait(2)

// 上传按钮图标化后计数进了 aria-label（原先是可见文字「上传参考图（1／6）」），故按前缀匹配
const refUploaded = await js(String.raw`(() => document.body.innerText.includes('参考图已上传') || [...document.querySelectorAll('.ws-panel button')].some(b => (b.getAttribute('aria-label') || '').startsWith('上传参考图（1')))()`)
cliLog('refUploaded=' + refUploaded)

// 提交 2 张生成
await js(String.raw`(() => {
  const ta = document.querySelector('.ws-panel textarea')
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, '验收：基于参考图的生成')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  const num = document.querySelector('.ws-panel input[type="number"]')
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(num, '2')
  num.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)
await js(String.raw`(() => {
  const btn = [...document.querySelectorAll('.ws-panel button')].find(b => b.innerText.trim() === '生成')
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
  const num = document.querySelector('.ws-panel input[type="number"]')
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(num, '2')
  num.dispatchEvent(new Event('input', { bubbles: true }))
  const ta = document.querySelector('.ws-panel textarea')
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, '验收：取消退额')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)
await js(String.raw`(() => {
  const btn = [...document.querySelectorAll('.ws-panel button')].find(b => b.innerText.trim() === '生成')
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
// 若走了取消路径，应有退回 toast
const refundToast = await js(String.raw`(() => { const t = document.querySelector('.ws-toast'); return t ? t.innerText : null })()`)
cliLog('refundToast=' + refundToast)
EOF
echo "[accept] D ✅"

# ---------- E：个人资料 + 修改密码 + 错误路径 ----------
echo "[accept] E: profile + password + error paths"
ego-browser nodejs <<'EOF'
const E2E = JSON.parse((await import('node:fs')).readFileSync('/tmp/motif-accept-env.json', 'utf8'))
const task = await useOrCreateTaskSpace('motif acceptance')
await ensureRealTab()

// 打开个人资料
await js(String.raw`(() => {
  const b = [...document.querySelectorAll('.ws-nav button')].find(x => x.innerText.trim() === '验收员')
  b.click(); return true
})()`)
await wait(1)
const opened = await js(String.raw`(() => !![...document.querySelectorAll('.ws-modal')].find(m => m.innerText.includes('个人资料')))()`)
if (!opened) throw new Error('个人资料弹窗未打开')

// 改昵称
await js(String.raw`(() => {
  const m = [...document.querySelectorAll('.ws-modal')].find(x => x.innerText.includes('个人资料'))
  const input = m.querySelector('#pf-name')
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
  const b = [...document.querySelectorAll('.ws-nav button')].find(x => x.innerText.trim() === '首席验收官')
  b.click(); return true
})()`)
await wait(1)
await js(String.raw`(() => {
  const m = [...document.querySelectorAll('.ws-modal')].find(x => x.innerText.includes('个人资料'))
  const setVal = (sel, v) => {
    const el = m.querySelector(sel)
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  setVal('#pf-oldpw', 'wrong-old-pw')
  setVal('#pf-newpw', 'accept-99-new')
  ;[...m.querySelectorAll('button')].find(b => b.innerText.trim() === '修改密码').click()
  return true
})()`)
await wait(2)
const errShown = await js(String.raw`(() => {
  const m = [...document.querySelectorAll('.ws-modal')].find(x => x.innerText.includes('个人资料'))
  return !!m.querySelector('.lp-alert-error')
})()`)
cliLog('wrong-old-password error shown=' + errShown)
if (!errShown) throw new Error('错误旧密码未提示')

// 正确旧密码 → 修改成功（弹窗自动关闭 + toast）
await js(String.raw`(() => {
  const m = [...document.querySelectorAll('.ws-modal')].find(x => x.innerText.includes('个人资料'))
  const setVal = (sel, v) => {
    const el = m.querySelector(sel)
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  setVal('#pf-oldpw', 'accept-66')
  setVal('#pf-newpw', 'accept-99-new')
  ;[...m.querySelectorAll('button')].find(b => b.innerText.trim() === '修改密码').click()
  return true
})()`)
await wait(2)
const pwOk = await js(String.raw`(() => document.body.innerText.includes('密码已修改'))()`)
cliLog('password changed=' + pwOk)
if (!pwOk) throw new Error('修改密码未成功')

// 登出 → 旧密码登录应失败 → 新密码登录成功
await js(String.raw`(() => {
  const b = [...document.querySelectorAll('.ws-nav button')].find(x => x.innerText.trim() === '退出')
  b.click(); return true
})()`)
await wait(3)
await js(String.raw`(() => {
  const email = '${E2E.email}'
  const setVal = (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const inputs = [...document.querySelectorAll('#auth form input')]
  setVal(inputs[0], email)
  setVal(inputs[1], 'accept-66')
  return true
})()`)
await js(String.raw`(() => { [...document.querySelectorAll('#auth form button[type="submit"]')][0].click(); return true })()`)
await wait(3)
const oldRejected = await js(String.raw`(() => !!document.querySelector('.lp-alert-error'))()`)
cliLog('old password rejected=' + oldRejected)
if (!oldRejected) throw new Error('旧密码未被拒绝')

await js(String.raw`(() => {
  const email = '${E2E.email}'
  const setVal = (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const inputs = [...document.querySelectorAll('#auth form input')]
  setVal(inputs[0], email)
  setVal(inputs[1], 'accept-99-new')
  return true
})()`)
await js(String.raw`(() => { [...document.querySelectorAll('#auth form button[type="submit"]')][0].click(); return true })()`)
await wait(4)
const relogin = await js(String.raw`(() => !!document.querySelector('.ws-shell'))()`)
cliLog('new password login=' + relogin)
if (!relogin) throw new Error('新密码登录失败')
EOF
echo "[accept] E ✅"

# ---------- F：画布交互（拖拽/选中/工具栏/@引用/整理/灯箱/删除）----------
echo "[accept] F: canvas interactions"
ego-browser nodejs <<'EOF'
const task = await useOrCreateTaskSpace('motif acceptance')
await ensureRealTab()

// 定位第一张图片卡片的视口中心
const center = await js(String.raw`(() => {
  const card = document.querySelector('.canvas-img-card')
  if (!card) throw new Error('画布上没有图片卡片')
  const r = card.getBoundingClientRect()
  return { cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2), left: Math.round(r.x), top: Math.round(r.y), w: Math.round(r.width) }
})()`)
cliLog('card center: ' + JSON.stringify(center))

// 记录拖拽前的世界坐标（left/top 样式值）
const posBefore = await js(String.raw`(() => {
  const card = document.querySelector('.canvas-img-card')
  return { left: card.style.left, top: card.style.top }
})()`)

// 拖拽图片 → 自由移动
await dragMouse([[center.cx, center.cy], [center.cx + 160, center.cy + 90]], { label: 'drag canvas image' })
await wait(1)
const posAfter = await js(String.raw`(() => {
  const card = document.querySelector('.canvas-img-card')
  return { left: card.style.left, top: card.style.top }
})()`)
cliLog(`drag: ${JSON.stringify(posBefore)} → ${JSON.stringify(posAfter)}`)
if (posAfter.left === posBefore.left) throw new Error('拖拽后图片位置未变化')

// 点击图片 → 选中 + 浮动工具栏出现
await dragMouse([[center.cx + 160, center.cy + 90], [center.cx + 160, center.cy + 90]], { label: 'noop hold' })
await click([center.cx + 160, center.cy + 90], { label: 'select image' })
await wait(1)
const sel = await js(String.raw`(() => ({
  pill: (document.querySelector('.canvas-pill') || {}).innerText?.replace(/\n/g, ' ') || null,
  toolbar: !!document.querySelector('.canvas-toolbar'),
  toolTitles: [...document.querySelectorAll('.canvas-toolbar [title]')].map(b => b.getAttribute('title'))
}))()`)
cliLog('selection: ' + JSON.stringify(sel))
if (!sel.pill || !sel.pill.includes('已选 1')) throw new Error('选中态未出现: ' + sel.pill)
if (!sel.toolbar) throw new Error('浮动工具栏未出现')
if (!sel.toolTitles.includes('加入参考图，并把编号写进提示词') || !sel.toolTitles.includes('删除所选图片')) throw new Error('工具栏按钮不全: ' + JSON.stringify(sel.toolTitles))

// @ 引用 → 提示词写入 #编号 且参考图计数 +1
await js(String.raw`(() => {
  const b = [...document.querySelectorAll('.canvas-toolbar button')].find(x => x.getAttribute('title')?.includes('参考图'))
  b.click(); return true
})()`)
await wait(1)
const refState = await js(String.raw`(() => ({
  promptHasSerial: /#\d{3}/.test(document.querySelector('.ws-panel textarea').value),
  refBtn: [...document.querySelectorAll('.ws-panel button')].find(b => (b.getAttribute('aria-label') || '').startsWith('上传参考图'))?.getAttribute('aria-label') || null
}))()`)
cliLog('reference: ' + JSON.stringify(refState))
if (!refState.promptHasSerial) throw new Error('@ 引用未把编号写入提示词')

// 双击图片 → 灯箱；Esc 关闭
await doubleClick([center.cx + 160, center.cy + 90], { label: 'open lightbox' })
await wait(1)
const lightbox = await js(String.raw`(() => !!document.querySelector('.canvas-lightbox'))()`)
cliLog('lightbox open=' + lightbox)
if (!lightbox) throw new Error('双击灯箱未打开')
await pressKey('Escape')
await wait(1)
const lightboxClosed = await js(String.raw`(() => !document.querySelector('.canvas-lightbox'))()`)
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
  const card = document.querySelector('.canvas-img-card')
  return { left: card.style.left, top: card.style.top }
})()`)
cliLog('arranged: ' + JSON.stringify(posArranged))
if (posArranged.left === posAfter.left && posArranged.top === posAfter.top) throw new Error('整理布局未吸附网格')

// 删除选中图片 → 画布减少一张
const countBefore = await js(String.raw`(() => document.querySelectorAll('.canvas-img-card').length)()`)
// 重新选中并删除
const c2 = await js(String.raw`(() => {
  const card = document.querySelector('.canvas-img-card')
  const r = card.getBoundingClientRect()
  return { cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) }
})()`)
await click([c2.cx, c2.cy], { label: 'select for delete' })
await wait(1)
await js(String.raw`(() => {
  const b = [...document.querySelectorAll('.canvas-toolbar button')].find(x => x.getAttribute('title') === '删除所选图片')
  b.click(); return true
})()`)
await wait(1)
// 确认对话框：校验文案要点后点击「删除」
const confirmModal = await js(String.raw`(() => {
  const m = [...document.querySelectorAll('.ws-modal')].find(x => x.innerText.includes('删除图片'))
  if (!m) return { open: false }
  return { open: true, hasCancel: [...m.querySelectorAll('button')].some(b => b.innerText.trim() === '取消'), serialNote: m.innerText.includes('编号') }
})()`)
cliLog('confirm modal: ' + JSON.stringify(confirmModal))
if (!confirmModal.open) throw new Error('删除确认框未出现')
if (!confirmModal.serialNote) throw new Error('确认框缺少编号不变说明')
await js(String.raw`(() => {
  const m = [...document.querySelectorAll('.ws-modal')].find(x => x.innerText.includes('删除图片'))
  ;[...m.querySelectorAll('button')].find(b => b.innerText.trim() === '删除').click()
  return true
})()`)
await wait(2)
const countAfter = await js(String.raw`(() => document.querySelectorAll('.canvas-img-card').length)()`)
cliLog(`delete: ${countBefore} → ${countAfter}`)
if (countAfter !== countBefore - 1) throw new Error('删除未生效')
EOF
echo "[accept] F ✅"

echo "[accept] 关闭任务空间"
ego-browser nodejs <<'EOF'
const task = await useOrCreateTaskSpace('motif acceptance')
const r = await completeTaskSpace(task.id, { keep: false })
cliLog('closed: ' + JSON.stringify(r))
EOF

echo ""
echo "[accept] 🎉 补充验收全部通过（A–F）"
