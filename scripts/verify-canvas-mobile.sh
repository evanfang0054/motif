#!/usr/bin/env bash
#
# 移动端可达性与窄屏布局的 CDP 验证（框选开关 / 撤销重做全选 / 溢出收敛 / 触摸目标 / 几何耦合）。
#
# 用法：bash scripts/verify-canvas-mobile.sh
#
# ⚠️ **只读真实数据**：复制数据目录到 /tmp，另占端口起短命 server，跑完删干净。
#    绝不对着 apps/web/.data 跑 —— 用例会拖卡片、改视口 meta。
# ⚠️ `MOTIF_INPROC_WORKER=false`：副本里可能留着未落地的队列任务，自带 worker 会接着真出图（烧额度）。
# ⚠️ `WORK` 必须与 A 段（`/tmp/motif-pinch`）**分开**：本脚本末尾会调用 A 段脚本，
#    它的 cleanup 是 `rm -rf` 自己的 WORK 再 `cp -R` 重建 —— 共用会被它抽换掉本脚本 server 正在读的数据目录。
#
# 观测口径（`viewport` 在 zustand store 里、不在 window 上，CDP 摸不到）：
#   k          → `button[aria-label="重置为 100%"]` 的文本
#   世界坐标   → 卡片 `offsetLeft/offsetTop`（**不随视口变**；屏幕坐标必失败，手势会改视口）
#   选框/选中  → `.canvas-marquee` / `.canvas-img-card-selected` 的存在性
#   溢出菜单   → `[role="menuitem"]`（只在 `toolbarLevel > 0` 时渲染）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_DIR="$ROOT/apps/web"
SRC_DATA="${MOTIF_DATA_DIR:-$WEB_DIR/.data}"
PORT=3313
BASE="http://127.0.0.1:$PORT"
WORK="/tmp/motif-mobile"
TMP_DATA="$WORK/.data"
# ⚠️ 日志不能写进 $WORK（cleanup 会 rm -rf 它）
LOG="/tmp/motif-mobile-verify.log"
PID=""

cleanup() {
  [ -n "$PID" ] && kill "$PID" 2>/dev/null || true
  lsof -ti :"$PORT" 2>/dev/null | xargs kill -9 2>/dev/null || true
  [ -n "$PID" ] && wait "$PID" 2>/dev/null || true
  rm -rf "$WORK"
  return 0
}
trap cleanup EXIT

[ -d "$SRC_DATA" ] || { echo "[mobile] ❌ 找不到数据目录 $SRC_DATA（先在 3100 上用一次，让它建库并出图）" >&2; exit 1; }
[ -f "$SRC_DATA/admin-credentials.txt" ] || { echo "[mobile] ❌ 副本里没有 admin-credentials.txt（登录兜底要用）" >&2; exit 1; }

cd "$WEB_DIR"
# 0. 构建守卫 —— 校验**新鲜度**，不只校验存在性。
#    踩过的坑：`[ ! -d .next/server ]` 在「跑过 dev 之后 .next/server 还在、但内容是旧的」时会
#    **静默服务旧代码**（实测服务的是 1.5 小时前的构建）。
need_build=0
if [ ! -f .next/BUILD_ID ]; then
  need_build=1
elif [ -n "$(find src ../packages -newer .next/BUILD_ID -type f \( -name '*.ts' -o -name '*.tsx' \) -print -quit 2>/dev/null)" ]; then
  need_build=1
fi
if [ "$need_build" = 1 ]; then
  echo "[mobile] 构建产物缺失或陈旧，先 pnpm build（会重写 .next，请先停 dev）..."
  pnpm build
fi

# 1. 复制真实数据目录（用例会拖卡片、改视口，绝不能对着真实库跑）
mkdir -p "$WORK"
rm -rf "$TMP_DATA"
cp -R "$SRC_DATA" "$TMP_DATA"
echo "[mobile] 已复制数据目录 → $TMP_DATA"

# 2. 起短命 server
( MOTIF_DATA_DIR="$TMP_DATA" MOTIF_INPROC_WORKER=false NODE_USE_ENV_PROXY=1 \
    pnpm exec next start -p "$PORT" > /tmp/motif-mobile-server.log 2>&1 ) &
PID=$!
for i in $(seq 1 40); do
  curl -s -o /dev/null "$BASE/" && break
  sleep 1
done
curl -s -o /dev/null "$BASE/" || { echo "[mobile] ❌ server 没起来，见 /tmp/motif-mobile-server.log" >&2; exit 1; }
echo "[mobile] server ready :$PORT"

# 3. CDP 验证
echo "[mobile] 开始 CDP 验证（完整日志 → $LOG）"
ego_status=0
ego-browser nodejs <<'EOF' 2>&1 | tee "$LOG" || ego_status=$?
const fs = await import('node:fs')

const BASE = 'http://127.0.0.1:3313'
const CRED = fs.readFileSync('/tmp/motif-mobile/.data/admin-credentials.txt', 'utf8')
const PASSWORD = (CRED.match(/密码:\s*(.+)/) || [])[1]
if (!PASSWORD) throw new Error('未能从 admin-credentials.txt 读到密码')

const spaces = await listTaskSpaces()
const found = spaces.find((s) => s.name === 'motif pinch verify')
const task = found ? await taskSpace(found.id) : await taskSpace('motif pinch verify')
const page = task.page('p1')

const fail = (msg) => {
  throw new Error(msg)
}

// ---------- 视口与仿真 ----------
/**
 * ⚠️ `(pointer: coarse)` **不能**靠 `mobile: true` 命中（实测 `mobile:true` 下它仍为 false），
 * 必须用 `Emulation.setEmulatedMedia` 显式仿真 media feature。实测有效（coarse=true）。
 */
const setViewport = async (w, h, mobile = true) => {
  await page.cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile })
  // ⚠️ 关闭时**不要**传 `maxTouchPoints: 0` —— CDP 会以「Touch points must be between 1 and 16」拒掉，
  //    而且报错发生在**下一次** `dispatchTouchEvent` 时，看起来像是别处的问题（实测踩过）。
  await page.cdp('Emulation.setTouchEmulationEnabled', mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false })
  await page.cdp('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: mobile ? 'coarse' : 'fine' }] })
  await page.waitForTimeout(600)
}

// ---------- DOM 观测面 ----------
const frameSync = () => page.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))))
const stageBox = () =>
  page.evaluate(() => {
    const s = document.querySelector('.canvas-stage')
    if (!s) throw new Error('.canvas-stage 未找到')
    const r = s.getBoundingClientRect()
    return { left: r.left, top: r.top, width: r.width, height: r.height, right: r.right, bottom: r.bottom }
  })
const cardCount = () => page.evaluate(() => document.querySelectorAll('.canvas-img-card:not(.canvas-skeleton-card)').length)
const selectedCount = () => page.evaluate(() => document.querySelectorAll('.canvas-img-card-selected').length)
const marqueeCount = () => page.evaluate(() => document.querySelectorAll('.canvas-marquee').length)
const readK = () =>
  page.evaluate(() => {
    const b = document.querySelector('.canvas-zoombar button[aria-label="重置为 100%"]')
    if (!b) throw new Error('缩放读数按钮未找到（被收走了？）')
    return parseInt((b.innerText || '').replace('%', ''), 10)
  })
/** 卡片**世界坐标**（`position: absolute`，offsetParent 就是世界层 ⇒ 不随视口变） */
const cardWorld = (i = 0) =>
  page.evaluate((idx) => {
    const c = document.querySelectorAll('.canvas-img-card:not(.canvas-skeleton-card)')[idx]
    if (!c) throw new Error('卡片 #' + idx + ' 不存在')
    return { x: c.offsetLeft, y: c.offsetTop }
  }, i)
const cardScreen = (i = 0) =>
  page.evaluate((idx) => {
    const c = document.querySelectorAll('.canvas-img-card:not(.canvas-skeleton-card)')[idx]
    if (!c) throw new Error('卡片 #' + idx + ' 不存在')
    const r = c.getBoundingClientRect()
    return { left: r.left, top: r.top, width: r.width, height: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }
  }, i)
/** 该点最上层是不是图片卡片 */
const hitCard = (pt) =>
  page.evaluate((p) => {
    const el = document.elementFromPoint(p.x, p.y)
    return el ? !!el.closest('.canvas-img-card') : false
  }, pt)
/** 第一张**中心在画布可视区内、且该点真的能命中它**的卡片下标；-1 = 一张都没有
 *  ⚠️ 卡片的世界坐标可能在视口外（实测某任务首卡在 x=600 而移动视口仅 390px）——
 *  触摸坐标落在可视区外时事件根本不派发，用例会以「手势无效」的假象失败。
 *  ⚠️ 还要过 `elementFromPoint`：宽屏下两侧浮动面板**浮在画布之上**，卡片中心落在面板底下时
 *  坐标虽在画布内、点击却打在面板上（实测 1440 下鼠标点选卡片失败的真因）。 */
const visibleCardIndex = async () => {
  const box = await stageBox()
  return await page.evaluate((b) => {
    const cs = [...document.querySelectorAll('.canvas-img-card:not(.canvas-skeleton-card)')]
    for (let i = 0; i < cs.length; i++) {
      const r = cs[i].getBoundingClientRect()
      const cx = r.left + r.width / 2
      const cy = r.top + r.height / 2
      if (cx <= b.left + 4 || cx >= b.right - 4 || cy <= b.top + 4 || cy >= b.bottom - 4) continue
      const el = document.elementFromPoint(cx, cy)
      if (el && el.closest('.canvas-img-card')) return i
    }
    return -1
  }, box)
}
const near = (a, b, tol = 2) => Math.abs(a - b) <= tol

// ---------- 触摸 / 鼠标 ----------
const touch = (type, points) =>
  page.cdp('Input.dispatchTouchEvent', {
    type,
    touchPoints: points.map((pt, i) => ({ x: pt.x, y: pt.y, id: pt.id ?? i + 1 })),
  })
const tapPoint = async (pt) => {
  await touch('touchStart', [pt])
  await frameSync()
  await touch('touchEnd', [])
  await frameSync()
}
/** 单指拖拽（空白处）：给一串增量，逐帧派发 */
const dragBy = async (from, deltas, id = 1) => {
  await touch('touchStart', [{ ...from, id }])
  await frameSync()
  for (const d of deltas) {
    await touch('touchMove', [{ x: from.x + d.dx, y: from.y + d.dy, id }])
    await frameSync()
  }
}

// ---------- 工具栏 / 菜单 ----------
const zoombarButtonPoint = (label) =>
  page.evaluate((l) => {
    const b = document.querySelector('.canvas-zoombar button[aria-label="' + l + '"]')
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }, label)
/** 点工具栏按钮：用 evaluate().click()，窄屏下按钮可能贴边，page.click 要求可点 */
const clickZoombar = (label) =>
  page.evaluate((l) => {
    const b = document.querySelector('.canvas-zoombar button[aria-label="' + l + '"]')
    if (!b) return false
    b.click()
    return true
  }, label)
const openMenu = async () => {
  const p = await zoombarButtonPoint('更多画布操作')
  if (!p) fail('溢出菜单触发器不存在（工具栏没收敛到 >0 档？）')
  await tapPoint(p)
  await page.waitForTimeout(600)
  const n = await page.evaluate(() => document.querySelectorAll('[role="menuitem"]').length)
  if (n === 0) fail('菜单没有打开（[role="menuitem"] 为 0）')
  return n
}
const closeMenu = async () => {
  await page.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await page.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await page.waitForTimeout(400)
}
const menuItemPoint = (text) =>
  page.evaluate((t) => {
    const m = [...document.querySelectorAll('[role="menuitem"]')].find((x) => (x.innerText || '').trim() === t)
    if (!m) return null
    const r = m.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }, text)
/** 点菜单项并**断言它存在**（不存在就是前置条件不成立，不能静默跳过） */
const clickMenuItem = async (text) => {
  const p = await menuItemPoint(text)
  if (!p) fail('菜单里没有「' + text + '」项')
  await tapPoint(p)
  await page.waitForTimeout(600)
}
/** 按「包含」匹配点菜单项：开关类菜单项的文字会带 `✓ ` 前缀（如 `✓ 溯源`），精确匹配会漏 */
const clickMenuItemIncludes = async (sub) => {
  const p = await page.evaluate((s) => {
    const m = [...document.querySelectorAll('[role="menuitem"]')].find((x) => (x.innerText || '').includes(s))
    if (!m) return null
    const r = m.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }, sub)
  if (!p) fail('菜单里没有含「' + sub + '」的项')
  await tapPoint(p)
  await page.waitForTimeout(600)
}
const menuTexts = () => page.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].map((m) => (m.innerText || '').trim()))
/** 找空白点（不落在卡片、不在工具栏上，且在画布内） */
const findEmptyPoint = async (preferTop = false) => {
  const box = await stageBox()
  for (let ty = preferTop ? 0.06 : 0.12; ty < 0.9; ty += 0.06) {
    for (let tx = 0.06; tx < 0.95; tx += 0.06) {
      const p = { x: box.left + box.width * tx, y: box.top + box.height * ty }
      const ok = await page.evaluate((q) => {
        const el = document.elementFromPoint(q.x, q.y)
        if (!el) return false
        if (el.closest('.canvas-img-card')) return false
        if (el.closest('.canvas-zoombar')) return false
        return !!el.closest('.canvas-stage')
      }, p)
      if (ok) return p
    }
  }
  return null
}

// ---------- 启动 ----------
const hasCards = () => page.evaluate(() => document.querySelectorAll('.canvas-img-card:not(.canvas-skeleton-card)').length > 0)
/**
 * 保证画布上有卡片。
 *
 * ⚠️ **不要**一上来就点任务列表：窄屏（≤1023）下左面板是**底部抽屉**，任务列表根本不在 DOM 里
 * （而且真展开它还会盖住画布底部的工具栏）。实测应用会**恢复上次的任务**，所以窄屏下走「已恢复」这条路；
 * 只有宽屏（面板是侧边整列）才回退到点任务列表。
 */
const ensureTopic = async () => {
  for (let i = 0; i < 12; i++) {
    if (await hasCards()) return 'restored'
    await page.waitForTimeout(500)
  }
  const clicked = await page.evaluate(() => {
    const items = [...document.querySelectorAll('.ws-topic-item')]
    if (!items.length) return null
    const it = items.find((x) => !/0 张/.test(x.innerText)) || items[0]
    it.click()
    return it.innerText.replace(/\s+/g, ' ').slice(0, 10)
  })
  if (!clicked) fail('画布没有卡片，也找不到任务列表（窄屏下左面板是抽屉，需先在宽屏选好任务再跑）')
  await page.waitForFunction(() => document.querySelectorAll('.canvas-img-card:not(.canvas-skeleton-card)').length > 0, undefined, {
    timeout: 20000,
  })
  return 'picked:' + clicked
}
const boot = async (w, h, mobile = true) => {
  await setViewport(w, h, mobile)
  await page.goto(BASE + '/')
  await page.waitForLoadState('load')
  await page.waitForTimeout(1500)
  if (!(await page.evaluate(() => !!document.querySelector('.ws-shell')))) {
    const r = await page.fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@motif.local', password: PASSWORD }),
    })
    if (!r.ok) fail('登录失败 HTTP ' + r.status)
    await page.goto(BASE + '/')
    await page.waitForLoadState('load')
    await page.waitForTimeout(1500)
  }
  // 关「修改密码提醒」弹窗：管理员带 mustChangePassword，它会盖住画布并吞掉所有事件
  await page.evaluate(() => {
    const m = document.querySelector('.modal__container')
    if (!m || !m.innerText.includes('修改密码')) return
    const b = [...m.querySelectorAll('button')].find((x) => x.innerText.trim() === '稍后')
    if (b) b.click()
  })
  await page.waitForTimeout(400)
  const key = await ensureTopic()
  await page.waitForTimeout(1200) // 等工具栏收敛（每档 120ms + 防抖）
  return key
}
/** 把卡片移进可视区。窄屏下工具栏那个「适应」按钮**已被收走** ⇒ 走菜单里的等价项（顺带验证 C11） */
const ensureVisible = async () => {
  if ((await visibleCardIndex()) >= 0) return 'already'
  if (await clickZoombar('适应')) {
    await page.waitForTimeout(600)
    if ((await visibleCardIndex()) >= 0) return 'toolbar'
  }
  await openMenu()
  await clickMenuItem('适应')
  if ((await visibleCardIndex()) < 0) fail('「适应」之后卡片中心仍不在可视区内')
  return 'menu'
}
/** 拿一张**在可视区内**的卡片的屏幕坐标与下标（拿不到就失败，不静默退化成下标 0） */
const visibleCard = async (tag) => {
  const i = await visibleCardIndex()
  if (i < 0) fail(tag + ' 无法进行：没有一张卡片的中心落在画布可视区内')
  return { i, ...(await cardScreen(i)) }
}

const TOPIC = await boot(375, 812)
console.log('TOPIC ' + TOPIC)
console.log('COARSE coarse=' + (await page.evaluate(() => matchMedia('(pointer: coarse)').matches)) + ' mobile=true')
console.log('ENSURE ' + (await ensureVisible()))

// ---------- MARQUEE_OFF / MARQUEE_ON：开关真的切换手势（B2 / B1）----------
// ⚠️ **观测面别用错**：平移改的是**视口**，卡片的**世界坐标（offsetLeft/offsetTop）不会变** ——
//    世界坐标只能证明「卡片自己没被拖动」。所以判「有没有平移」必须用**屏幕坐标**，
//    判「卡片有没有被拖走」才用世界坐标。设计文档里的 ③ 原文只写了世界坐标，执行时发现它
//    对「视口平移」没有判别力，故这里补上屏幕坐标那一条（两条一起断言）。
{
  const empty = await findEmptyPoint(true)
  if (!empty) fail('MARQUEE_OFF 无法进行：找不到空白点（画布被卡片铺满？）')
  const ci = await visibleCardIndex()
  if (ci < 0) fail('MARQUEE_OFF 无法进行：没有卡片在可视区内（读不到屏幕坐标）')
  const s0 = await cardScreen(ci)
  const w0 = await cardWorld(ci)
  await dragBy(empty, [{ dx: 30, dy: 0 }, { dx: 60, dy: 0 }])
  await touch('touchEnd', [])
  await frameSync()
  await page.waitForTimeout(400)
  const s1 = await cardScreen(ci)
  const w1 = await cardWorld(ci)
  console.log(
    'MARQUEE_OFF 屏幕 Δleft=' + (s1.left - s0.left).toFixed(1) + ' 世界 Δ=(' + (w1.x - w0.x).toFixed(1) + ',' + (w1.y - w0.y).toFixed(1) + ') 选框数=' + (await marqueeCount()),
  )
  if (!near(s1.left - s0.left, 60)) fail('MARQUEE_OFF 失败：关着「框选」时单指拖空白没有平移（本用例会退化成空转）')
  if ((await marqueeCount()) !== 0) fail('MARQUEE_OFF 失败：关着「框选」却出现了选框')

  // 打开「框选」
  if (!(await clickZoombar('框选'))) fail('MARQUEE_ON 无法进行：工具栏上没有「框选」按钮')
  await page.waitForTimeout(400)
  const k0 = await readK()
  const v0 = await cardWorld(ci)
  const e0 = await cardScreen(ci)
  const empty2 = await findEmptyPoint(true)
  if (!empty2) fail('MARQUEE_ON 无法进行：找不到空白点')
  await dragBy(empty2, [{ dx: 20, dy: 20 }, { dx: 40, dy: 40 }])
  const marquee = await marqueeCount()
  await touch('touchEnd', [])
  await frameSync()
  await page.waitForTimeout(400)
  const k1 = await readK()
  const v1 = await cardWorld(ci)
  const e1 = await cardScreen(ci)
  console.log(
    'MARQUEE_ON 选框数=' +
      marquee +
      ' k ' +
      k0 +
      '→' +
      k1 +
      ' 屏幕 Δ=(' +
      (e1.left - e0.left).toFixed(1) +
      ',' +
      (e1.top - e0.top).toFixed(1) +
      ') 世界 Δ=(' +
      (v1.x - v0.x).toFixed(1) +
      ',' +
      (v1.y - v0.y).toFixed(1) +
      ')',
  )
  // 四条一起断言：只测「出现选框」无法排除「同时也在平移/缩放」
  if (marquee < 1) fail('MARQUEE_ON 失败：开着「框选」拖空白没有出现 .canvas-marquee')
  if (k1 !== k0) fail('MARQUEE_ON 失败：框选的同时发生了缩放')
  if (!near(e1.left, e0.left, 1) || !near(e1.top, e0.top, 1)) fail('MARQUEE_ON 失败：框选的同时发生了平移（屏幕坐标变了）')
  if (!near(v1.x, v0.x, 1) || !near(v1.y, v0.y, 1)) fail('MARQUEE_ON 失败：框选的同时卡片被拖走了（世界坐标变了）')
}

// ---------- MARQUEE_PICK：框真的把卡片圈进来了（B4）----------
{
  // 「框选」此刻仍开着（上一条结束时没有关）
  let picked = null
  for (let idx = 0; idx < (await cardCount()); idx++) {
    const c = await cardScreen(idx)
    for (const off of [16, 28, 40]) {
      const start = { x: c.left - off, y: c.top - off }
      const box = await stageBox()
      if (start.x < box.left + 2 || start.y < box.top + 2) continue
      if (await hitCard(start)) continue
      picked = { idx, start, end: { x: c.left + c.width + off, y: c.top + c.height + off }, c }
      break
    }
    if (picked) break
  }
  if (!picked) fail('MARQUEE_PICK 无法进行：找不到「卡片外」的起点（先量卡位置这一步没做成）')
  // 先清空选中，避免把「本来就选中」误判成本次框选的结果
  await page.evaluate(() => document.querySelector('.canvas-zoombar button[aria-label="框选"]').blur())
  await dragBy(picked.start, [{ dx: 0, dy: 0 }])
  await touch('touchMove', [{ x: picked.end.x, y: picked.end.y, id: 1 }])
  await frameSync()
  const m = await marqueeCount()
  await touch('touchEnd', [])
  await frameSync()
  await page.waitForTimeout(600)
  const sel = await page.evaluate((i) => document.querySelectorAll('.canvas-img-card')[i].classList.contains('canvas-img-card-selected'), picked.idx)
  console.log('MARQUEE_PICK 选框数=' + m + ' 卡片#' + picked.idx + ' 被选中=' + sel + ' 选中总数=' + (await selectedCount()))
  if (m < 1) fail('MARQUEE_PICK 失败：拖拽过程中没有出现选框')
  if (!sel) fail('MARQUEE_PICK 失败：框覆盖了卡片 #' + picked.idx + ' 但抬起后它没有被选中')
}

// ---------- VIEW_MENU：视图开关被收走时有等价入口，且真的生效（C11 两态）----------
// ⚠️ **实测档位**：视图开关在 **360/320 才被收走** —— 393/375 只收到「整理布局」那一档就装下了。
//    所以「已收走」那一态必须在 320 跑，「未收走」那一态在 393 断言。
{
  await boot(393, 852)
  const at393 = await page.evaluate(() => !!document.querySelector('.canvas-zoombar button[aria-label="适应"]'))
  if (!at393) fail('VIEW_MENU 前提不成立：393 下「适应」不在工具栏上（预期未被收走）')
  await openMenu()
  const t393 = await menuTexts()
  await closeMenu()
  if (t393.includes('适应') || t393.includes('溯源')) fail('VIEW_MENU 失败：视图开关未被收走，菜单里却出现了「适应」「溯源」')
  console.log('VIEW_MENU 393 未收走：工具栏有「适应」，菜单里没有 ✓')

  await boot(320, 568)
  const at320 = await page.evaluate(() => !!document.querySelector('.canvas-zoombar button[aria-label="适应"]'))
  if (at320) fail('VIEW_MENU 前提不成立：320 下「适应」仍在工具栏上（预期已被收走）')
  // 先造一个「不是适应值」的 k，否则点「适应」可能恰好不变
  await clickZoombar('重置为 100%')
  await page.waitForTimeout(300)
  await clickZoombar('放大')
  await page.waitForTimeout(300)
  const k0 = await readK()
  await openMenu()
  const texts = await menuTexts()
  console.log('VIEW_MENU 320 菜单项=' + JSON.stringify(texts))
  if (!texts.includes('适应') || !texts.includes('溯源')) fail('VIEW_MENU 失败：视图开关被收走，菜单里却没有「适应」「溯源」')
  await clickMenuItem('适应')
  const k1 = await readK()
  console.log('VIEW_MENU 点「适应」k ' + k0 + '→' + k1)
  if (k1 === k0) fail('VIEW_MENU 失败：菜单里的「适应」点了没反应（k 没变）')
  // 溯源：点它后按钮态翻转（用菜单里的 ✓ 表达）
  await openMenu()
  await clickMenuItem('溯源')
  await openMenu()
  const texts2 = await menuTexts()
  console.log('VIEW_MENU 开溯源后菜单项=' + JSON.stringify(texts2.filter((t) => t.includes('溯源'))))
  if (!texts2.some((t) => t.includes('✓ 溯源'))) fail('VIEW_MENU 失败：菜单里的「溯源」点了没生效（没有出现 ✓）')
  await clickMenuItemIncludes('溯源') // 关回去（此时文字是「✓ 溯源」），免得整理提示干扰后面的几何断言
}

// ---------- MENU_ITEMS / UNDO_REDO / SELECT_ALL（B6）----------
{
  const n = await openMenu()
  const texts = await menuTexts()
  console.log('MENU_ITEMS 项数=' + n + ' 含撤销=' + texts.includes('撤销') + ' 含重做=' + texts.includes('重做') + ' 含全选=' + texts.includes('全选'))
  if (!texts.includes('撤销') || !texts.includes('重做') || !texts.includes('全选')) fail('MENU_ITEMS 失败：菜单里缺撤销/重做/全选')
  await closeMenu()

  const c = await visibleCard('UNDO_REDO')
  const w0 = await cardWorld(c.i)
  await dragBy({ x: c.cx, y: c.cy }, [{ dx: 20, dy: 20 }, { dx: 40, dy: 40 }])
  await touch('touchEnd', [])
  await frameSync()
  await page.waitForTimeout(600)
  const w1 = await cardWorld(c.i)
  if (near(w1.x, w0.x, 1) && near(w1.y, w0.y, 1)) fail('UNDO_REDO 前提不成立：拖拽没有产生位移')
  await openMenu()
  await clickMenuItem('撤销')
  const w2 = await cardWorld(c.i)
  console.log('UNDO_REDO 拖后=(' + w1.x + ',' + w1.y + ') 撤销后=(' + w2.x + ',' + w2.y + ') 拖前=(' + w0.x + ',' + w0.y + ')')
  if (!near(w2.x, w0.x, 1) || !near(w2.y, w0.y, 1)) fail('UNDO_REDO 失败：撤销后没有回到拖动前的世界坐标')
  await openMenu()
  await clickMenuItem('重做')
  const w3 = await cardWorld(c.i)
  console.log('UNDO_REDO 重做后=(' + w3.x + ',' + w3.y + ')')
  if (!near(w3.x, w1.x, 1) || !near(w3.y, w1.y, 1)) fail('UNDO_REDO 失败：重做后没有回到拖动后的世界坐标')

  await openMenu()
  await clickMenuItem('全选')
  const sel = await selectedCount()
  const total = await cardCount()
  console.log('SELECT_ALL 选中=' + sel + ' 图片数=' + total)
  if (!(sel === total && sel > 0)) fail('SELECT_ALL 失败：全选后选中数 ' + sel + ' ≠ 图片数 ' + total)
}

// ---------- CLEAR_SEL：读数区被收走时菜单里有等价入口（B8 两态）----------
{
  const statusVisible = await page.evaluate(() => !!document.querySelector('.canvas-status'))
  const sel0 = await selectedCount()
  if (statusVisible) fail('CLEAR_SEL 前提不成立：本档下读数区仍在 DOM 里（预期已被收走）')
  if (sel0 === 0) fail('CLEAR_SEL 前提不成立：此刻没有选中项')
  await openMenu()
  const texts = await menuTexts()
  if (!texts.includes('清空选择')) fail('CLEAR_SEL 失败：读数区被收走且有选中，菜单里却没有「清空选择」')
  await clickMenuItem('清空选择')
  const sel1 = await selectedCount()
  console.log('CLEAR_SEL 点前选中=' + sel0 + ' 点后=' + sel1 + ' 状态区在 DOM=' + statusVisible)
  if (sel1 !== 0) fail('CLEAR_SEL 失败：点「清空选择」后仍有选中')
  await openMenu()
  const texts2 = await menuTexts()
  await closeMenu()
  if (texts2.includes('清空选择')) fail('CLEAR_SEL 失败：无选中时「清空选择」仍然存在（应不出现）')
  console.log('CLEAR_SEL 无选中时该项不存在 ✓')
}

// ---------- DISABLED：不可用时置灰，且点了没有副作用（B7）----------
{
  // 刷新后历史清空 ⇒ 撤销/重做应置灰
  const key = await boot(375, 812)
  await openMenu()
  const probe = await page.evaluate(() => {
    const m = [...document.querySelectorAll('[role="menuitem"]')]
    const pick = (t) => {
      const el = m.find((x) => (x.innerText || '').trim() === t)
      if (!el) return null
      return { aria: el.getAttribute('aria-disabled'), data: el.getAttribute('data-disabled') }
    }
    return { undo: pick('撤销'), redo: pick('重做'), all: pick('全选') }
  })
  console.log('DISABLED 属性 ' + JSON.stringify(probe) + ' （topic=' + key + '）')
  for (const [name, v] of [
    ['撤销', probe.undo],
    ['重做', probe.redo],
  ]) {
    if (!v) fail('DISABLED 失败：菜单里没有「' + name + '」')
    if (!(v.aria === 'true' || v.data === 'true')) fail('DISABLED 失败：无历史时「' + name + '」没有禁用语义（aria/data 都是 null）')
  }
  // 行为双保险：点它不得改变世界坐标与选中数
  const w0 = await cardWorld(0)
  const s0 = await selectedCount()
  await clickMenuItem('撤销')
  const w1 = await cardWorld(0)
  const s1 = await selectedCount()
  console.log('DISABLED 点置灰的「撤销」后 世界坐标 Δ=(' + (w1.x - w0.x) + ',' + (w1.y - w0.y) + ') 选中 ' + s0 + '→' + s1)
  if (w1.x !== w0.x || w1.y !== w0.y || s1 !== s0) fail('DISABLED 失败：点了置灰的「撤销」却改变了状态')
  await closeMenu()
}

// ---------- NO_CLIP：四档 × 两态，无按钮越出画布（C2）+ 320 下框选仍在（C3）----------
const noClip = async (tag) => {
  const r = await page.evaluate(() => {
    const stage = document.querySelector('.canvas-stage')
    const z = document.querySelector('.canvas-zoombar')
    if (!stage || !z) return { err: 'stage/zoombar 缺失' }
    const s = stage.getBoundingClientRect()
    const bad = []
    for (const b of z.querySelectorAll('button')) {
      const q = b.getBoundingClientRect()
      if (q.width === 0 && q.height === 0) continue
      if (q.left < s.left - 1 || q.right > s.right + 1) {
        bad.push((b.getAttribute('aria-label') || b.innerText || '').trim() + '@' + Math.round(q.left) + '..' + Math.round(q.right))
      }
    }
    return {
      scrollW: z.scrollWidth,
      clientW: z.clientWidth,
      bad,
      stage: Math.round(s.left) + '..' + Math.round(s.right),
      marquee: !!z.querySelector('button[aria-label="框选"]'),
      status: !!document.querySelector('.canvas-status'),
      labels: [...z.querySelectorAll('button')].map((b) => (b.getAttribute('aria-label') || b.innerText || '').trim()),
    }
  })
  if (r.err) fail('NO_CLIP ' + tag + ' 无法进行：' + r.err)
  console.log(
    'NO_CLIP ' + tag + ' scrollW=' + r.scrollW + ' clientW=' + r.clientW + ' stage=' + r.stage + ' 越界=' + JSON.stringify(r.bad) + ' 框选在=' + r.marquee,
  )
  if (r.bad.length) fail('NO_CLIP ' + tag + ' 失败：这些按钮越出画布 ' + JSON.stringify(r.bad))
  return r
}
const TIERS = [
  { w: 393, h: 852, name: '393×852' },
  { w: 375, h: 812, name: '375×812' },
  { w: 360, h: 800, name: '360×800' },
  { w: 320, h: 568, name: '320×568' },
]
const tierResults = []
for (const t of TIERS) {
  await boot(t.w, t.h)
  await ensureVisible()
  const un = await noClip(t.name + ' 未选中')
  // 选中 1 张
  const c = await visibleCard('NO_CLIP ' + t.name)
  if (!(await hitCard({ x: c.cx, y: c.cy }))) fail('NO_CLIP ' + t.name + ' 无法进行：卡片中心没命中卡片（可能在可视区外）')
  await tapPoint({ x: c.cx, y: c.cy })
  await page.waitForTimeout(700)
  const sel = await selectedCount()
  if (sel !== 1) fail('NO_CLIP ' + t.name + ' 前提不成立：期望选中 1 张，实际 ' + sel)
  const se = await noClip(t.name + ' 选中 1 张')
  tierResults.push({ tier: t.name, un: un.scrollW, se: se.scrollW, marquee: se.marquee, status: se.status, labels: se.labels })
  // C4：读数区被收走后不在可见 DOM
  if (t.w === 375 && se.status) fail('C4 失败：375 选中时读数区仍在 DOM 里（预期已被收走）')
  // C3：320 下框选仍在画布内（且真的还在工具栏上 —— 收到最末档它就没了）
  if (t.w === 320) {
    if (!se.marquee) fail('MARQUEE_VISIBLE_320 失败：320 下「框选」按钮不在工具栏上（被收进菜单了）')
    const inside = await page.evaluate(() => {
      const b = document.querySelector('.canvas-zoombar button[aria-label="框选"]')
      const s = document.querySelector('.canvas-stage').getBoundingClientRect()
      const q = b.getBoundingClientRect()
      return q.left >= s.left - 1 && q.right <= s.right + 1
    })
    console.log('MARQUEE_VISIBLE_320 在画布内=' + inside)
    if (!inside) fail('MARQUEE_VISIBLE_320 失败：320 下「框选」按钮越出画布')
  }
}
console.log('NO_CLIP 汇总 ' + JSON.stringify(tierResults))

// ---------- TOUCH_TARGET：coarse 命中时按钮 ≥44×44（C5）----------
{
  const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches)
  if (!coarse) {
    console.log('TOUCH_TARGET ⚠️ 未验证：本环境 (pointer: coarse) 不命中 ⇒ 触摸目标尺寸未测（如实记录，不写恒真断言）')
  } else {
    // 选中一张，让 `.canvas-toolbar` 也在场
    const c = await visibleCard('TOUCH_TARGET')
    await tapPoint({ x: c.cx, y: c.cy })
    await page.waitForTimeout(700)
    const r = await page.evaluate(() => {
      const out = []
      for (const sel of ['.canvas-zoombar', '.canvas-toolbar']) {
        const host = document.querySelector(sel)
        if (!host) {
          out.push({ sel, missing: true })
          continue
        }
        const small = []
        for (const b of host.querySelectorAll('button')) {
          const q = b.getBoundingClientRect()
          if (q.width === 0 && q.height === 0) continue
          if (q.width < 44 || q.height < 44) small.push((b.getAttribute('aria-label') || '').trim() + ' ' + Math.round(q.width) + '×' + Math.round(q.height))
        }
        out.push({ sel, n: host.querySelectorAll('button').length, small })
      }
      return out
    })
    console.log('TOUCH_TARGET coarse=true ' + JSON.stringify(r))
    for (const o of r) {
      if (o.missing) fail('TOUCH_TARGET 失败：' + o.sel + ' 不存在（选中一张后应出现）')
      if (o.small.length) fail('TOUCH_TARGET 失败：' + o.sel + ' 里这些按钮小于 44×44 ' + JSON.stringify(o.small))
    }
  }
}

// ---------- NO_OVERLAP：C8 / C9 / C8+ / C8++（桌面视口）----------
{
  await boot(1440, 900, false)
  await ensureVisible()
  const overlap = (a, b) => !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom)
  // C8：浮动工具栏不压住被选中卡片
  const vc = await visibleCard('NO_OVERLAP C8')
  await page.mouse.click(vc.cx, vc.cy)
  await page.waitForTimeout(700)
  const g = await page.evaluate(() => {
    const t = document.querySelector('.canvas-toolbar[aria-label="图片操作"]')
    const card = document.querySelector('.canvas-img-card-selected')
    if (!t || !card) return null
    const a = t.getBoundingClientRect()
    const b = card.getBoundingClientRect()
    return { t: { left: a.left, top: a.top, right: a.right, bottom: a.bottom }, c: { left: b.left, top: b.top, right: b.right, bottom: b.bottom } }
  })
  if (!g) fail('NO_OVERLAP C8 无法进行：选中工具栏或被选中卡片没出现')
  const c8 = overlap(g.t, g.c)
  console.log('NO_OVERLAP C8 工具栏与卡片相交=' + c8 + ' toolbar=' + JSON.stringify(g.t) + ' card=' + JSON.stringify(g.c))
  if (c8) fail('NO_OVERLAP C8 失败：浮动工具栏压住了被选中卡片')

  // C8+：浮动面板与底部工具栏不相交
  const p = await page.evaluate(() => {
    const panel = document.querySelector('.ws-float-panel')
    const z = document.querySelector('.canvas-zoombar')
    if (!panel || !z) return null
    const a = panel.getBoundingClientRect()
    const b = z.getBoundingClientRect()
    return { p: { left: a.left, top: a.top, right: a.right, bottom: a.bottom }, z: { left: b.left, top: b.top, right: b.right, bottom: b.bottom } }
  })
  if (!p) fail('NO_OVERLAP C8+ 无法进行：.ws-float-panel 或 .canvas-zoombar 不存在')
  const c8p = overlap(p.p, p.z)
  console.log('NO_OVERLAP C8+ 浮动面板与底部工具栏相交=' + c8p + ' panel=' + JSON.stringify(p.p) + ' zoombar=' + JSON.stringify(p.z))
  if (c8p) fail('NO_OVERLAP C8+ 失败：浮动面板压住了底部工具栏')

  // C9：整理提示（只在「溯源打开且摆放与来源不一致」时出现）—— 不存在则记日志跳过
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.innerText || '').includes('溯源') || (x.getAttribute('aria-label') || '') === '溯源')
    if (b) b.click()
  })
  await page.waitForTimeout(1200)
  const hint = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.canvas-stage button')].find((x) => (x.innerText || '').includes('布局与来源不一致'))
    if (!btn) return null
    const wrap = btn.closest('div')
    const r = wrap.getBoundingClientRect()
    const z = document.querySelector('.canvas-zoombar').getBoundingClientRect()
    return { h: { left: r.left, top: r.top, right: r.right, bottom: r.bottom }, z: { left: z.left, top: z.top, right: z.right, bottom: z.bottom } }
  })
  if (!hint) {
    console.log('NO_OVERLAP C9 ⏭ 跳过：整理提示不存在（溯源打开但摆放与来源一致）—— 按契约记为「不存在则跳过」')
  } else {
    const c9 = overlap(hint.h, hint.z)
    console.log('NO_OVERLAP C9 提示条与底部工具栏相交=' + c9)
    if (c9) fail('NO_OVERLAP C9 失败：整理提示压住了底部工具栏')
  }
}

// ---------- C8++：1024 下打开小地图，工具栏与小地图不相交（Task 2 Step 3b 的唯一回归网）----------
{
  await boot(1024, 768, false)
  await ensureVisible()
  const trigger = await page.evaluate(() => {
    const b = document.querySelector('.canvas-zoombar button[aria-label="小地图"]')
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  if (!trigger) fail('NO_OVERLAP C8++ 无法进行：1024 下工具栏上没有「小地图」开关')
  await page.mouse.click(trigger.x, trigger.y)
  await page.waitForTimeout(900)
  const r = await page.evaluate(() => {
    const mini = document.querySelector('[data-testid="canvas-minimap"]')
    const z = document.querySelector('.canvas-zoombar')
    if (!mini) return { err: '小地图没渲染' }
    const a = mini.getBoundingClientRect()
    const b = z.getBoundingClientRect()
    return {
      mini: { left: a.left, top: a.top, right: a.right, bottom: a.bottom },
      z: { left: b.left, top: b.top, right: b.right, bottom: b.bottom },
      zLeft: Math.round(b.left),
      zMaxW: Math.round(parseFloat(getComputedStyle(z).maxWidth) || 0),
    }
  })
  if (r.err) fail('NO_OVERLAP C8++ 失败：' + r.err)
  const ov = !(r.mini.right <= r.z.left || r.mini.left >= r.z.right || r.mini.bottom <= r.z.top || r.mini.top >= r.z.bottom)
  console.log('NO_OVERLAP C8++ 小地图与工具栏相交=' + ov + ' mini=' + JSON.stringify(r.mini) + ' zoombar=' + JSON.stringify(r.z) + ' zoombarLeft=' + r.zLeft)
  if (ov) fail('NO_OVERLAP C8++ 失败：小地图与底部工具栏重叠')
}

// ---------- VIEWPORT_META：viewport-fit=cover（C6）----------
// ⚠️ 从 DOM 读而不是 `page.fetch('/')` 再 `.text()`（ego-browser 的 fetch 响应没有 `text()`，实测）。
{
  const content = await page.evaluate(() => document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? null)
  console.log('VIEWPORT_META content=' + content)
  if (!content || !/viewport-fit=cover/.test(content)) fail('VIEWPORT_META 失败：<meta name="viewport"> 的 content 里没有 viewport-fit=cover')
}

// ---------- B7 第二半（无图时「全选」置灰）：**不可达**，如实记为未覆盖 ----------
// `CanvasStage` 只在 `canvasImages.length > 0 || skeletons.length > 0` 时渲染（Workspace.tsx 的三元），
// 所以「一张图都没有」时画布与它的工具栏**都不存在**，菜单自然也不存在 ⇒ 这条没有可观测面。
// ⚠️ 放在**最后**：新建任务会把「当前任务」切走并跨刷新保留，后面还有用例的话会全部落空。
{
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button[aria-label="新建任务"]')].find((x) => x.offsetParent !== null)
    if (b) b.click()
  })
  await page.waitForTimeout(3000)
  const noCanvas = await page.evaluate(() => !document.querySelector('.canvas-zoombar'))
  console.log('DISABLED_NOIMG 空任务下 .canvas-zoombar 不存在=' + noCanvas + ' ⇒ B7 第二半无观测面，记为未覆盖（非通过）')
  if (!noCanvas) {
    // 万一将来画布在空任务下也渲染了，这条就有观测面了 —— 那时必须补真断言，不能静默
    const n = await openMenu()
    const texts = await menuTexts()
    const all = await page.evaluate(() => {
      const el = [...document.querySelectorAll('[role="menuitem"]')].find((x) => (x.innerText || '').trim() === '全选')
      return el ? { aria: el.getAttribute('aria-disabled'), data: el.getAttribute('data-disabled') } : null
    })
    console.log('DISABLED_NOIMG 菜单项数=' + n + ' 全选属性=' + JSON.stringify(all) + ' 项=' + JSON.stringify(texts))
    if (all && !(all.aria === 'true' || all.data === 'true')) fail('DISABLED_NOIMG 失败：无图时「全选」没有禁用语义')
    await closeMenu()
  }
}

console.log('✅ 移动端可达性、窄屏布局、触摸目标与几何耦合全部通过')
EOF

echo "[mobile] ego 退出码=$ego_status"
if [ "$ego_status" != 0 ]; then exit "$ego_status"; fi

# 4. 复用 A 段的桌面四条回归（不另写一份）
# ⚠️ 它会自己再起一轮 server（自带 trap），耗时约 40s —— 换来的是桌面回归只有一份实现。
echo "[mobile] 复用画布手势回归（含桌面四条）"
bash "$ROOT/scripts/verify-canvas-pinch.sh"
