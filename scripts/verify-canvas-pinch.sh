#!/usr/bin/env bash
#
# 画布双指手势（pinch 缩放 + 双指平移）的 CDP 多点验证。
#
# 用法：bash scripts/verify-canvas-pinch.sh
#
# ⚠️ **只读**：复制真实数据目录到 /tmp，另占端口起短命 server，跑完删干净。
#    绝不对着 apps/web/.data 跑 —— 手势会写视口 meta。
# ⚠️ `MOTIF_INPROC_WORKER=false`：副本里可能留着未落地的队列任务，自带 worker 会接着真出图（烧额度）。
#
# ⚠️ 收尾时会在末尾打印一行 `Terminated: 15 ... next start ...` —— 那是 trap 正常收掉短命 server
#    时 shell 的作业通知，**不是失败**（脚本的退出码只看最后一行的 `ego 退出码`）。
#
# 观测口径（`viewport` 在 zustand store 里、不在 window 上，CDP 摸不到 ⇒ 只认两个 DOM 面）：
#   k        → 缩放读数按钮 `button[aria-label="重置为 100%"]` 的文本（渲染 Math.round(k*100)+'%'）
#   x/y/锚点 → 图片卡片的矩形；而「图片有没有被移动」必须读**世界坐标**（offsetLeft/offsetTop）——
#              手势会改视口，屏幕坐标必然变，拿它当「没移动」的判据是错的。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_DIR="$ROOT/apps/web"
SRC_DATA="${MOTIF_DATA_DIR:-$WEB_DIR/.data}"
PORT=3310
BASE="http://127.0.0.1:$PORT"
WORK="/tmp/motif-pinch"
TMP_DATA="$WORK/.data"
LOG="/tmp/motif-pinch-verify.log"
PID=""

cleanup() {
  [ -n "$PID" ] && kill "$PID" 2>/dev/null || true
  lsof -ti :"$PORT" 2>/dev/null | xargs kill -9 2>/dev/null || true
  # 收尸：不等的话 shell 会在脚本末尾打印一行「Terminated: 15 ...」，
  # 读日志的人容易误判成脚本失败了（其实只是短命 server 被正常收掉）。
  [ -n "$PID" ] && wait "$PID" 2>/dev/null || true
  rm -rf "$WORK"
  return 0
}
trap cleanup EXIT

[ -d "$SRC_DATA" ] || { echo "[pinch] ❌ 找不到数据目录 $SRC_DATA（先在 3100 上用一次，让它建库并出图）" >&2; exit 1; }
[ -f "$SRC_DATA/admin-credentials.txt" ] || { echo "[pinch] ❌ 副本里没有 admin-credentials.txt（登录兜底要用）" >&2; exit 1; }

cd "$WEB_DIR"
# 0. 构建守卫 —— ⚠️ 必须校验**新鲜度**，不能只校验存在性。
#    踩过的坑：`e2e/run.sh` 的 `[ ! -d .next/server ]` 判据在「跑过 dev 之后 .next/server 还在、
#    但内容是旧的」时会**静默服务旧代码** —— 实测服务的是 1.5 小时前的构建，白白诊断了半天。
#    判据：`.next/BUILD_ID` 的 mtime 必须晚于 src / packages 下最新的源文件。
need_build=0
if [ ! -f .next/BUILD_ID ]; then
  need_build=1
elif [ -n "$(find src ../packages -newer .next/BUILD_ID -type f \( -name '*.ts' -o -name '*.tsx' \) -print -quit 2>/dev/null)" ]; then
  need_build=1
fi
if [ "$need_build" = 1 ]; then
  echo "[pinch] 构建产物缺失或陈旧，先 pnpm build（会重写 .next，请先停 dev）..."
  pnpm build
fi

# 1. 复制真实数据目录（视口会落库，绝不能对着真实库跑）
mkdir -p "$WORK"
rm -rf "$TMP_DATA"
cp -R "$SRC_DATA" "$TMP_DATA"
echo "[pinch] 已复制数据目录 → $TMP_DATA"

# 2. 起短命 server
( MOTIF_DATA_DIR="$TMP_DATA" MOTIF_INPROC_WORKER=false NODE_USE_ENV_PROXY=1 \
    pnpm exec next start -p "$PORT" > /tmp/motif-pinch-server.log 2>&1 ) &
PID=$!
for i in $(seq 1 40); do
  curl -s -o /dev/null "$BASE/" && break
  sleep 1
done
curl -s -o /dev/null "$BASE/" || { echo "[pinch] ❌ server 没起来，见 /tmp/motif-pinch-server.log" >&2; exit 1; }
echo "[pinch] server ready :$PORT"

# 3. CDP 多点验证
echo "[pinch] 开始 CDP 验证（完整日志 → $LOG）"
ego_status=0
ego-browser nodejs <<'EOF' 2>&1 | tee "$LOG" || ego_status=$?
const fs = await import('node:fs')

const BASE = 'http://127.0.0.1:3310'
const CRED_FILE = '/tmp/motif-pinch/.data/admin-credentials.txt'

// 凭据来自**副本**里的 admin-credentials.txt
const CRED = fs.readFileSync(CRED_FILE, 'utf8')
const PASSWORD = (CRED.match(/密码:\s*(.+)/) || [])[1]
if (!PASSWORD) throw new Error('未能从 admin-credentials.txt 读到密码')

const spaces = await listTaskSpaces()
const SPACE = 'motif pinch verify'
const found = spaces.find((s) => s.name === SPACE)
const task = found ? await taskSpace(found.id) : await taskSpace(SPACE)
const page = task.page('p1')

// 移动视口 + 触屏仿真（pointerType 才会是 'touch'）
await page.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true })
await page.cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })

await page.goto(BASE + '/')
await page.waitForLoadState('load')
await page.waitForTimeout(1500)

// 会话 cookie 在同一浏览器 profile 里跨端口有效；失效则用凭据重登
if (!(await page.evaluate(() => !!document.querySelector('.ws-shell')))) {
  const r = await page.fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@motif.local', password: PASSWORD }),
  })
  if (!r.ok) throw new Error('登录失败 HTTP ' + r.status)
  await page.goto(BASE + '/')
  await page.waitForLoadState('load')
  await page.waitForTimeout(1500)
}

// 关掉「修改密码提醒」弹窗 —— 管理员账号带 mustChangePassword，登录后它会盖住整个画布
// （实测：A 点的 elementFromPoint 是 modal__backdrop--opaque，触摸事件全被它吞掉 ⇒ 手势零响应）。
// 处置照抄 scripts/measure-canvas-perf.sh 的写法。
await page.evaluate(() => {
  const m = document.querySelector('.modal__container')
  if (!m || !m.innerText.includes('修改密码')) return
  const b = [...m.querySelectorAll('button')].find((x) => x.innerText.trim() === '稍后')
  if (b) b.click()
})
await page.waitForTimeout(600)

// 选一个**有图**的任务（画布只在有图/有骨架时渲染），并等卡片出现
const picked = await page.evaluate(() => {
  const items = [...document.querySelectorAll('.ws-topic-item')]
  if (!items.length) return null
  items[0].click()
  return items[0].innerText.slice(0, 30)
})
console.log('TOPIC ' + picked)
await page.waitForFunction(
  () => document.querySelectorAll('.canvas-img-card:not(.canvas-skeleton-card)').length > 0,
  undefined,
  { timeout: 20000 },
)
await page.waitForTimeout(800) // 等工具栏尺寸测量 effect 落定

const frameSync = () =>
  page.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))))

const READ_K = '.canvas-zoombar button[aria-label="重置为 100%"]'
const readK = () =>
  page.evaluate((sel) => {
    const b = document.querySelector(sel)
    if (!b) throw new Error('缩放读数按钮未找到')
    return parseInt((b.innerText || '').replace('%', ''), 10)
  }, READ_K)
/** 点读数按钮 = 把 k 归一到 1。⚠️ 用 evaluate 而不是 page.click：窄屏工具栏可能被裁切，page.click 要求可点 */
const resetK = () => page.evaluate((sel) => document.querySelector(sel).click(), READ_K)
const FIT = '.canvas-zoombar button[aria-label="适应"]'
/**
 * 点「适应」把卡片移进可视区。
 * ⚠️ 为什么必须做：真实数据里卡片的**世界坐标**可能落在视口之外（实测某任务的首张卡在 x=600，
 *    而移动视口只有 390px 宽）⇒ `Input.dispatchTouchEvent` 的坐标落在可视区外时
 *    `elementFromPoint` 返回 null、事件根本不派发，用例会以「手势无效」的假象失败。
 */
const fitView = () => page.evaluate((sel) => {
  const b = document.querySelector(sel)
  if (!b) throw new Error('「适应」按钮未找到')
  b.click()
}, FIT)
/** 该点是否真的命中图片卡片（在可视区内且最上层是卡片） */
const cardHit = (pt) =>
  page.evaluate((p) => {
    const el = document.elementFromPoint(p.x, p.y)
    return el ? !!el.closest('.canvas-img-card') : false
  }, pt)
const cardRect = () =>
  page.evaluate(() => {
    const c = document.querySelector('.canvas-img-card:not(.canvas-skeleton-card)')
    if (!c) throw new Error('画布上没有图片卡片')
    const r = c.getBoundingClientRect()
    return { left: r.left, top: r.top, width: r.width, height: r.height }
  })
/**
 * 卡片的**世界坐标**（不随视口变）。
 * 卡片 `position: absolute` 且 offsetParent 就是世界层（世界层的 transform 只影响绘制，
 * 不改 offsetLeft/offsetTop）⇒ 这两个值即世界坐标。
 */
const cardWorld = () =>
  page.evaluate(() => {
    const c = document.querySelector('.canvas-img-card:not(.canvas-skeleton-card)')
    if (!c) throw new Error('画布上没有图片卡片')
    return { x: c.offsetLeft, y: c.offsetTop }
  })
const stageBox = () =>
  page.evaluate(() => {
    const s = document.querySelector('.canvas-stage')
    if (!s) throw new Error('.canvas-stage 未找到')
    const r = s.getBoundingClientRect()
    return { left: r.left, top: r.top, width: r.width, height: r.height }
  })

const touch = (type, points) =>
  page.cdp('Input.dispatchTouchEvent', {
    type,
    touchPoints: points.map((pt, i) => ({ x: pt.x, y: pt.y, id: i + 1 })),
  })
const near = (a, b, tol = 2) => Math.abs(a - b) <= tol

// 开场：把视口归一到 k = 1（真实库里可能存着非 1 的 k，而缩放用例要求起始 k 必须为 1）
await resetK()
await page.waitForTimeout(300)
{
  const k = await readK()
  if (k !== 100) throw new Error('开场归一失败：读数不是 100%，实际 ' + k + '%')
}
console.log('RESET k=100')

const box = await stageBox()
const A = { x: box.left + box.width / 2, y: box.top + box.height / 2 } // 视口坐标的锚点

// ---------- PINCH_ZOOM + ANCHOR：指距拉开 1.5 倍，锚点不动 ----------
{
  const k0 = await readK()
  const r0 = await cardRect()
  const half = 60
  await touch('touchStart', [{ x: A.x - half, y: A.y }, { x: A.x + half, y: A.y }])
  await frameSync()
  for (let i = 1; i <= 6; i++) {
    const h = half * (1 + (0.5 * i) / 6) // 终点 1.5 倍 ⇒ 指距 120 → 180，dDist = 60 > 24
    await touch('touchMove', [{ x: A.x - h, y: A.y }, { x: A.x + h, y: A.y }])
    await frameSync()
  }
  await touch('touchEnd', [])
  await frameSync()
  await page.waitForTimeout(500)
  const k1 = await readK()
  const r1 = await cardRect()
  const f = k1 / k0
  console.log('PINCH_ZOOM k ' + k0 + ' → ' + k1 + ' (倍率 ' + f.toFixed(3) + ')')
  if (!(k1 > k0)) throw new Error('PINCH_ZOOM 失败：指距拉开后 k 没有变大')
  if (f < 1.4 || f > 1.6) throw new Error('PINCH_ZOOM 失败：倍率不在 1.4–1.6，实际 ' + f.toFixed(3))
  const ax = box.width / 2
  const ay = box.height / 2
  const expLeft = (r0.left - box.left - ax) * f + ax + box.left
  const expTop = (r0.top - box.top - ay) * f + ay + box.top
  console.log(
    'ANCHOR 期望 ' + expLeft.toFixed(1) + '/' + expTop.toFixed(1) + ' 实际 ' + r1.left.toFixed(1) + '/' + r1.top.toFixed(1),
  )
  if (!near(expLeft, r1.left) || !near(expTop, r1.top)) {
    throw new Error('ANCHOR 失败：锚点映射不成立（偏差 ' + (r1.left - expLeft).toFixed(2) + 'px）')
  }
}

// ---------- TWO_FINGER_PAN：双指严格平行 → 平移，尺寸不变 ----------
{
  const k0 = await readK()
  const r0 = await cardRect()
  const p1 = { x: A.x - 60, y: A.y }
  const p2 = { x: A.x + 60, y: A.y }
  await touch('touchStart', [p1, p2])
  await frameSync()
  for (const d of [10, 20, 30]) {
    await touch('touchMove', [{ x: p1.x + d, y: p1.y + d }, { x: p2.x + d, y: p2.y + d }])
    await frameSync()
  }
  await touch('touchEnd', [])
  await frameSync()
  await page.waitForTimeout(500)
  const k1 = await readK()
  const r1 = await cardRect()
  console.log(
    'TWO_FINGER_PAN k ' + k0 + '→' + k1 + ' Δleft=' + (r1.left - r0.left).toFixed(1) + ' Δtop=' + (r1.top - r0.top).toFixed(1),
  )
  if (k1 !== k0) throw new Error('TWO_FINGER_PAN 失败：被误判成缩放（k 变了）')
  if (!near(r1.left - r0.left, 30) || !near(r1.top - r0.top, 30)) throw new Error('TWO_FINGER_PAN 失败：卡片未按 (30,30) 平移')
  if (r1.width !== r0.width || r1.height !== r0.height) throw new Error('TWO_FINGER_PAN 失败：卡片尺寸变了')
}

// ---------- CARD_PINCH：两指都落在同一张图片卡内 → 仍能捏合，且该卡未被拖 ----------
{
  await fitView() // 先把卡片移进可视区（真实数据的卡片可能在视口外）
  await page.waitForTimeout(600)
  const c = await page.evaluate(() => {
    const el = document.querySelector('.canvas-img-card:not(.canvas-skeleton-card)')
    const r = el.getBoundingClientRect()
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width, h: r.height }
  })
  const k0 = await readK()
  const w0 = await cardWorld()
  const r0 = await cardRect()
  // 前提：卡片够宽，否则 dDist 越不过 24px 阈值（dDist = 2h = 2·min(20, c.w/6) > 24 ⇒ c.w > 72）
  if (c.w < 80) {
    throw new Error('CARD_PINCH 无法进行：卡片宽 ' + c.w.toFixed(0) + 'px 太小（dDist 越不过 24px 阈值），请换一张方图/横图')
  }
  const h = Math.min(20, c.w / 6)
  // 前提：两指起点必须真的落在卡片上（D4 的定义就是「手指落在图片上」）
  const hitA = await cardHit({ x: c.cx - h, y: c.cy })
  const hitB = await cardHit({ x: c.cx + h, y: c.cy })
  if (!hitA || !hitB) {
    throw new Error(
      'CARD_PINCH 无法进行：两指起点没有落在图片卡片上（' +
        JSON.stringify({ cx: c.cx, cy: c.cy, w: c.w }) +
        '）—— 卡片可能仍在可视区外',
    )
  }
  await touch('touchStart', [{ x: c.cx - h, y: c.cy }, { x: c.cx + h, y: c.cy }])
  await frameSync()
  for (let i = 1; i <= 5; i++) {
    const hh = h * (1 + (1.0 * i) / 5) // 终点 2 倍 ⇒ 指距 2h → 4h，dDist = 2h = 40 > 24
    await touch('touchMove', [{ x: c.cx - hh, y: c.cy }, { x: c.cx + hh, y: c.cy }])
    await frameSync()
  }
  await touch('touchEnd', [])
  await frameSync()
  await page.waitForTimeout(500)
  const k1 = await readK()
  const w1 = await cardWorld()
  const r1 = await cardRect()
  console.log('CARD_PINCH k ' + k0 + '→' + k1 + ' 世界坐标 Δ=(' + (w1.x - w0.x).toFixed(1) + ',' + (w1.y - w0.y).toFixed(1) + ')')
  if (!(k1 > k0)) throw new Error('CARD_PINCH 失败：手指落在图片上时捏合无效（捕获阶段没生效？）')
  // 反证：走的是 pinch（缩放）而不是卡片拖拽 —— 锚点是卡片**中心** ⇒
  //   ① 卡片**世界坐标不动**（没被拖）；② 屏幕宽度按读数倍率放大（确实缩放了）。
  // ⚠️ 不要用「屏幕 left 不变」当判据：以卡片中心为锚缩放时左边缘必然向外扩。
  if (!near(w1.x, w0.x, 1) || !near(w1.y, w0.y, 1)) {
    throw new Error('CARD_PINCH 失败：卡片世界坐标被改 ⇒ 走的可能是拖拽路径')
  }
  if (!near(r1.width, r0.width * (k1 / k0), 3)) {
    throw new Error(
      'CARD_PINCH 失败：卡片屏幕宽度未按读数倍率变化（' +
        r0.width.toFixed(1) +
        '→' +
        r1.width.toFixed(1) +
        '，读数 ' +
        k0 +
        '→' +
        k1 +
        '）',
    )
  }
}

// ---------- ONE_FINGER_LEFT：pinch 中只抬一根手指，剩余那根继续移动 ⇒ 不产生平移 ----------
// ⚠️ CDP 的 touchEnd 语义：`touchPoints` 传**仍在按下的点**。若实测发现语义相反，
//    把下面的 [p2] 改成 [p1] —— 不要靠猜。（两种语义下本用例的断言都成立：抬指后只剩一根、
//    pinchRef 已清空且 panRef 为 null ⇒ 都不会改视口。）
{
  const p1 = { x: A.x - 50, y: A.y }
  const p2 = { x: A.x + 50, y: A.y }
  await touch('touchStart', [p1, p2])
  await frameSync()
  await touch('touchMove', [{ x: p1.x - 30, y: p1.y }, { x: p2.x + 30, y: p2.y }]) // 先进入 zoom
  await frameSync()
  await touch('touchEnd', [p2]) // 只抬一根
  await frameSync()
  await page.waitForTimeout(300)
  const kA = await readK()
  const rA = await cardRect()
  for (const d of [20, 40]) {
    await touch('touchMove', [{ x: p2.x + d, y: p2.y }]) // 剩余那根继续移动
    await frameSync()
  }
  await touch('touchEnd', [])
  await frameSync()
  await page.waitForTimeout(500)
  const kB = await readK()
  const rB = await cardRect()
  console.log('ONE_FINGER_LEFT k ' + kA + '→' + kB + ' Δleft=' + (rB.left - rA.left).toFixed(1))
  if (kB !== kA || !near(rB.left - rA.left, 0, 2)) {
    throw new Error('ONE_FINGER_LEFT 失败：抬一指后剩余手指仍在改视口（应冻结到两指都抬起）')
  }
  // 再抬起后重新单指按下 ⇒ 平移恢复
  const rC = await cardRect()
  const s = { x: box.left + 40, y: box.top + box.height - 60 }
  await touch('touchStart', [s])
  await frameSync()
  for (const d of [15, 30]) {
    await touch('touchMove', [{ x: s.x + d, y: s.y }])
    await frameSync()
  }
  await touch('touchEnd', [])
  await frameSync()
  await page.waitForTimeout(500)
  const rD = await cardRect()
  console.log('ONE_FINGER_LEFT 重按后单指平移 Δleft=' + (rD.left - rC.left).toFixed(1))
  if (!near(rD.left - rC.left, 30)) throw new Error('ONE_FINGER_LEFT 失败：抬指后单指平移没有恢复')
}

// ---------- CANCEL_AFTER：touchCancel 不留幽灵触摸点 ----------
{
  const p1 = { x: A.x - 60, y: A.y }
  const p2 = { x: A.x + 60, y: A.y }
  await touch('touchStart', [p1, p2])
  await frameSync()
  await touch('touchMove', [{ x: p1.x - 20, y: p1.y }, { x: p2.x + 20, y: p2.y }])
  await frameSync()
  await touch('touchCancel', [])
  await frameSync()
  await page.waitForTimeout(500)
  const r0 = await cardRect()
  const s = { x: box.left + 40, y: box.top + box.height - 60 }
  await touch('touchStart', [s])
  await frameSync()
  for (const d of [15, 30]) {
    await touch('touchMove', [{ x: s.x + d, y: s.y }])
    await frameSync()
  }
  await touch('touchEnd', [])
  await frameSync()
  await page.waitForTimeout(500)
  const r1 = await cardRect()
  console.log('CANCEL_AFTER 单指平移 Δleft=' + (r1.left - r0.left).toFixed(1))
  if (!near(r1.left - r0.left, 30)) throw new Error('CANCEL_AFTER 失败：cancel 后单指平移异常（残留幽灵触摸点）')
}

// ---------- LAST_FRAME：pinch 结束后读数达到末帧值（最后一帧没被丢） ----------
{
  await resetK()
  await page.waitForTimeout(300)
  const p1 = { x: A.x - 50, y: A.y }
  const p2 = { x: A.x + 50, y: A.y }
  await touch('touchStart', [p1, p2])
  await frameSync()
  for (let i = 1; i <= 8; i++) {
    const h = 50 * (1 + (1.0 * i) / 8)
    await touch('touchMove', [{ x: A.x - h, y: A.y }, { x: A.x + h, y: A.y }])
    // 最后一次 move **故意不 frameSync**：让它在 touchEnd 时仍是「未 flush 的最后一帧」。
    // 它的值不读（rAF 没触发就读不到），但几何可算：起始指距 100、第 i 帧指距 2h
    // ⇒ factor = 1 + i/8 ⇒ 第 8 帧 factor = 2.0 ⇒ k = 200%（开场已归一到 100%）。
    if (i < 8) await frameSync()
  }
  await touch('touchEnd', [])
  await frameSync()
  await page.waitForTimeout(600) // 越过 400ms 防抖落库窗口
  const settled = await readK()
  const EXPECT_LAST = 200
  console.log('LAST_FRAME 期望末帧=' + EXPECT_LAST + ' settled=' + settled)
  // ⚠️ 判据必须用**算出来的末帧值**，不能用「前 7 帧的峰值」—— 前 7 帧峰值是 187.5，
  //    丢末帧时 settled 也正好是 187 ⇒ `settled < peak` 是 188 < 188 = 假 ⇒ 恒真、无判别力。
  // ⚠️ 本用例验证的是**可观测性质**（末帧的值没丢），不是「flush 被调用了」：
  //    删掉同步 flush，末帧的 rAF 仍会自行触发并提交同值 ⇒ 本用例不区分「有 flush/无 flush」。
  //    它真正能抓住的是「取消 rAF 且不提交」这个失败模式。
  if (settled < EXPECT_LAST) {
    throw new Error('LAST_FRAME 失败：结束后读数停在 ' + settled + '（末帧应为 ' + EXPECT_LAST + '）⇒ 最后一帧的值丢了')
  }
}

// ---------- DRAG_FREEZE：先单指拖图（在飞），再落第二指 ⇒ 图冻结在落指瞬间的位置 ----------
{
  await fitView() // 同上：卡片必须在可视区里，触摸事件才派发得出去
  await page.waitForTimeout(600)
  const c = await page.evaluate(() => {
    const el = document.querySelector('.canvas-img-card:not(.canvas-skeleton-card)')
    const r = el.getBoundingClientRect()
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 }
  })
  if (!(await cardHit({ x: c.cx, y: c.cy }))) {
    throw new Error('DRAG_FREEZE 无法进行：卡片中心没有命中卡片（可能在可视区外）')
  }
  const beforeDrag = await cardWorld()
  await touch('touchStart', [{ x: c.cx, y: c.cy }])
  await frameSync()
  await touch('touchMove', [{ x: c.cx + 40, y: c.cy + 40 }])
  await frameSync()
  await page.waitForTimeout(200) // 让拖拽的 rAF 落地
  const atLift = await cardWorld()
  // 有效性断言：拖拽**真的**发生了（否则「冻结」是空转）
  if (near(atLift.x, beforeDrag.x, 1) && near(atLift.y, beforeDrag.y, 1)) {
    throw new Error('DRAG_FREEZE 失败：单指拖拽没有产生位移 ⇒ 本用例是空转')
  }
  await touch('touchStart', [{ x: c.cx + 40, y: c.cy + 40 }, { x: c.cx + 120, y: c.cy + 40 }]) // 第二指落下 → pinch 接管
  await frameSync()
  for (const d of [10, 20]) {
    await touch('touchMove', [{ x: c.cx + 40 - d, y: c.cy + 40 }, { x: c.cx + 120 + d, y: c.cy + 40 }])
    await frameSync()
  }
  await touch('touchEnd', [])
  await frameSync()
  await page.waitForTimeout(500)
  const after = await cardWorld()
  console.log('DRAG_FREEZE 落指时世界坐标=(' + atLift.x + ',' + atLift.y + ') 结束后=(' + after.x + ',' + after.y + ')')
  // ⚠️ 用**世界坐标**断言：这段的第二个手势会改视口（指距 80→120 ⇒ 缩放），
  //    屏幕坐标必然变 —— 拿 getBoundingClientRect 的差值当判据必失败。
  if (!near(after.x, atLift.x, 1) || !near(after.y, atLift.y, 1)) {
    throw new Error('DRAG_FREEZE 失败：第二指落下后图片仍在继续移动（世界坐标变了）')
  }
}

console.log('✅ pinch 与共存性验证全部通过')
EOF

echo "[pinch] ego 退出码=$ego_status"
exit "$ego_status"
