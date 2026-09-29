#!/usr/bin/env bash
#
# 画布交互性能采样 —— 三场景 × N 次事件 × R 跑，取 CDP `ScriptDuration` 的中位数。
#
# 用法：bash scripts/measure-canvas-perf.sh <标签> [跑数] [每跑事件数]
#   bash scripts/measure-canvas-perf.sh main          # 5 跑 × 60 次
#   bash scripts/measure-canvas-perf.sh branch 1 6    # 冒烟
#
# 三场景（都走**真实 UI 事件**，不调 store 方法 —— 后者在页面上下文里拿不到）：
#   zoom        点「放大」/「缩小」交替 N 次（净位移 0，不会撞缩放上下限）
#   pan-select  先选中 1 张，再在空白处拖拽 N 次（前半程 +DX、后半程 -DX ⇒ 净位移 0）
#   pan-none    先清空选中，再拖拽 N 次（同上）
#
# ⚠️ 每跑前后各有一道**有效性断言**，不通过就抛错而不是交数字：
#   - 首个事件必须产生可见变化（卡片位移 / 缩放读数变化）—— 否则「拖拽没生效」会被当成
#     「性能极好」写进结论；
#   - 整跑结束必须回到起点 —— 否则下一跑起点不同，同一场景的几跑不可比。
#
# ⚠️ 前置（本脚本只采样，不起服务、不碰数据）：
#   1) 生产构建：`pnpm build`
#   2) 隔离数据副本 —— 画布视口会落库，**绝不能对着真实库跑**：
#        rm -rf /tmp/motif-perf/.data && cp -R apps/web/.data /tmp/motif-perf/.data
#   3) 起服务（3300；3200 被 Docker 容器占着）：
#        cd apps/web && MOTIF_DATA_DIR=/tmp/motif-perf/.data NODE_USE_ENV_PROXY=1 \
#          ./node_modules/.bin/next start -p 3300
#   4) 基线（main）与改动后（分支）必须在**同一会话**内各跑一次，且各自都从**同一份数据副本**
#      重新起服务 —— 否则视口/机器热漂移会让数字不可比。建议 A/B/A/B 交替各跑一轮再取中位数。
#
# 仪器边界：`ScriptDuration` 只覆盖**主线程 JS** 成本。本机无独立 GPU 进程，
# 合成/栅格成本不在本脚本范围内，结论不得表述为「整体流畅度」。
set -euo pipefail

LABEL="${1:?用法: $0 <标签，如 main|branch> [跑数] [每跑事件数]}"
RUNS="${2:-5}"
EVENTS="${3:-60}"
OUT="/tmp/motif-perf/result-$LABEL.txt"

mkdir -p /tmp/motif-perf
printf '{"label":"%s","runs":%s,"events":%s}\n' "$LABEL" "$RUNS" "$EVENTS" > /tmp/motif-perf/cfg.json

# heredoc 用 `<<'EOF'`（带引号）：免去 `$` 与反引号的转义，代价是脚本内拿不到父 shell 变量 ——
# 故参数经 /tmp/motif-perf/cfg.json 传入。
# ⚠️ 必须写 `2>&1`：ego-browser 的输出走 **stderr**，只接 stdout 的话 `tee` 会写出 0 字节文件。
ego-browser nodejs <<'EOF' 2>&1 | tee "$OUT"
const fs = await import('node:fs')

const CFG = JSON.parse(fs.readFileSync('/tmp/motif-perf/cfg.json', 'utf8'))
const CRED = fs.readFileSync('/tmp/motif-perf/.data/admin-credentials.txt', 'utf8')
const PASSWORD = (CRED.match(/密码:\s*(.+)/) || [])[1]
if (!PASSWORD) throw new Error('未能从 admin-credentials.txt 读到密码')

const BASE = 'http://localhost:3300'
const SPACE = 'motif canvas perf'
/** 空白拖拽点：两侧浮动面板（x ≤ 292 / x ≥ 1056）与卡片（x ≥ 775）之外 */
const EMPTY = [400, 450]
/** 每次拖拽的位移（CSS px）；前半程 +DX、后半程 -DX ⇒ 净位移 0 */
const DX = 12
const ZOOM_IN = '.canvas-zoombar button[aria-label="放大"]'
const ZOOM_OUT = '.canvas-zoombar button[aria-label="缩小"]'
const ZOOM_TEXT = '.canvas-zoombar button[aria-label="重置为 100%"]'
const CARD1 = '[aria-label="#001 参考图"]'
const CARD2 = '[aria-label="#002 图片 1"]'

const spaces = await listTaskSpaces()
const found = spaces.find((s) => s.name === SPACE)
const task = found ? await taskSpace(found.id) : await taskSpace(SPACE)
const page = task.page('p1')

// 该环境视口会塌成 0×0（点击全报 not visible），每轮先固定
await page.cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
// 不 enable 的话 getMetrics 返回空数组
await page.cdp('Performance.enable', {})

const readScript = async () => {
  const r = await page.cdp('Performance.getMetrics', {})
  const m = r.metrics.find((x) => x.name === 'ScriptDuration')
  if (!m) throw new Error('ScriptDuration 缺失（Performance 域未启用？）')
  return m.value
}

/** 一次取全部指标，用来判断「少渲染了」还是「每次渲染更便宜了」 */
const readMetrics = async () => {
  const r = await page.cdp('Performance.getMetrics', {})
  const get = (n) => (r.metrics.find((x) => x.name === n) || { value: NaN }).value
  return {
    script: get('ScriptDuration'),
    task: get('TaskDuration'),
    layout: get('LayoutCount'),
    recalc: get('RecalcStyleCount'),
  }
}

const readToolbar = () =>
  page.evaluate(() => {
    const tb = document.querySelector('.canvas-toolbar')
    const zoom = document.querySelector('.canvas-zoombar button[aria-label="重置为 100%"]')
    return {
      aria: tb ? tb.getAttribute('aria-label') : null,
      rect: tb
        ? (() => {
            const b = tb.getBoundingClientRect()
            return [b.x, b.y, b.width, b.height].map((n) => Math.round(n * 1000) / 1000)
          })()
        : null,
      zoomText: zoom ? zoom.innerText.trim() : null,
    }
  })

/** 拖拽点被卡片/面板/工具栏盖住时立即报错 —— 否则会把「拖卡片」误当成平移采进数字 */
const assertEmpty = async () => {
  const ok = await page.evaluate(
    ([x, y]) => {
      const el = document.elementFromPoint(x, y)
      if (!el) return false
      return !['.canvas-img-card', '.canvas-toolbar', '.ws-float-panel', '.canvas-zoombar', '.modal__container'].some((s) =>
        el.closest(s),
      )
    },
    EMPTY,
  )
  if (!ok) throw new Error(`空白拖拽点 ${EMPTY} 已被遮挡，本次采样不可信`)
}

/**
 * 等页面**静下来**再开测量窗。
 *
 * 画布视口落库是 400ms 防抖的：上一跑最后一个事件触发的保存，会在 400ms 后发请求，
 * 其响应处理（JSON 解析 + store 写入）会落进**下一跑的窗口**里，把那一跑抬高成倍。
 * 故开窗前先反复测「空转 400ms 的 ScriptDuration 增量」，直到它 < 1ms。
 */
const drain = async () => {
  for (let i = 0; i < 8; i++) {
    const a = await readScript()
    await page.waitForTimeout(400)
    if ((await readScript()) - a < 0.001) return true
  }
  return false
}

await page.goto(BASE + '/')
await page.waitForLoadState('load')

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
}

// 管理员账号带 mustChangePassword ⇒ 每次加载都会弹「建议修改密码」，先关掉
await page.evaluate(() => {
  const m = document.querySelector('.modal__container')
  if (!m || !m.innerText.includes('建议修改密码')) return
  const b = [...m.querySelectorAll('button')].find((x) => x.innerText.trim() === '稍后')
  if (b) b.click()
})
await page.waitForTimeout(400)

await page.evaluate(() => {
  const el = [...document.querySelectorAll('.ws-topic-item')].find((x) => x.innerText.includes('手套'))
  if (!el) throw new Error('未找到「手套」任务')
  el.click()
})
await page.waitForFunction(() => document.querySelectorAll('.canvas-img-in').length >= 20, undefined, { timeout: 20000 })
await page.waitForTimeout(800) // 等 bandInput / 工具栏尺寸测量 effect 落定

console.log(`ENV label=${CFG.label} runs=${CFG.runs} events=${CFG.events}`)

// D4：在**任何视口改动之前**取「同一组（选中集合 + 视口）」下的工具栏外框与缩放读数
await page.mouse.click(EMPTY[0], EMPTY[1], { label: '清空选中' })
await page.waitForTimeout(250)
await page.click(CARD1, { label: '单选第 1 张' })
await page.waitForTimeout(300)
const d4Single = await readToolbar()
await page.keyboard.down('Shift')
await page.click(CARD2, { label: '加选第 2 张' })
await page.keyboard.up('Shift')
await page.waitForTimeout(300)
const d4Multi = await readToolbar()
await page.mouse.click(EMPTY[0], EMPTY[1], { label: '清空选中' })
await page.waitForTimeout(250)
console.log(`D4 single ${JSON.stringify(d4Single)}`)
console.log(`D4 multi ${JSON.stringify(d4Multi)}`)

async function scenario(name, setup, act, probe) {
  const vals = []
  for (let r = 1; r <= CFG.runs; r++) {
    if (setup) {
      await setup()
      await page.waitForTimeout(200)
    }
    const settled = await drain()
    await assertEmpty()
    const p0 = probe ? await probe() : null
    const m0 = await readMetrics()
    const before = m0.script
    let mid = null
    for (let i = 0; i < CFG.events; i++) {
      await act(i)
      if (i === 0 && probe) mid = await probe()
    }
    // 平移的落地走 rAF：不等这一帧就会读到「最后一个事件还没生效」的位置，
    // 净位移断言会误报 +DX。等一帧再收窗口，顺带把最后一个事件的 JS 算进来。
    await page.waitForTimeout(120)
    const m1 = await readMetrics()
    const after = m1.script
    const p1 = probe ? await probe() : null
    if (probe) {
      if (mid === null || mid === p0) throw new Error(`${name} 第 ${r} 跑：首个事件没有可见变化 ⇒ 交互未生效，数字不可信`)
      if (p1 !== p0) throw new Error(`${name} 第 ${r} 跑：净位移不为 0（${p0} → ${p1}）⇒ 各跑起点不同，不可比`)
    }
    vals.push(after - before)
    console.log(
      `RUN ${name} ${r} ${(after - before).toFixed(4)} task=${(m1.task - m0.task).toFixed(4)}` +
        ` layout=${m1.layout - m0.layout} recalc=${m1.recalc - m0.recalc} settled=${settled}`,
    )
  }
  const sorted = [...vals].sort((a, b) => a - b)
  const median = sorted[(sorted.length - 1) >> 1]
  console.log(`MEDIAN ${name} ${median.toFixed(4)} spread=${(sorted[sorted.length - 1] - sorted[0]).toFixed(4)}`)
  return median
}

const clearSel = () => page.mouse.click(EMPTY[0], EMPTY[1], { label: '清空选中' })
const selectOne = () => page.click(CARD1, { label: '选中第 1 张' })

/**
 * 等两帧。
 *
 * 两个交互事件挨太近时，浏览器/React 会把它们合并成**一次**渲染 ⇒ 一跑里实际渲染几次
 * 取决于 CDP 往返快慢，同一场景几跑能差 4 倍（实测 pan-select 0.20 ↔ 0.84）。
 * 每个事件后等两帧，保证「一次事件 = 一次渲染」，数字才可比。
 * 代价是这点 page JS（两次 promise 决议，量级 0.01ms），相对每次事件 5–20ms 可忽略。
 */
const frameSync = () =>
  page.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))))

const zoomAct = async (i) => {
  await frameSync()
  await page.click(i % 2 === 0 ? ZOOM_IN : ZOOM_OUT, { label: '缩放' })
}
const zoomProbe = () => page.evaluate((s) => document.querySelector(s).innerText.trim(), ZOOM_TEXT)

const panAct = async (i) => {
  const dir = i < CFG.events / 2 ? 1 : -1
  await frameSync()
  await page.mouse.move(EMPTY[0], EMPTY[1])
  await page.mouse.down()
  await page.mouse.move(EMPTY[0] + dir * DX, EMPTY[1], { steps: 1 })
  await page.mouse.up()
}
const panProbe = () =>
  page.evaluate(() => {
    const b = document.querySelector('[aria-label="#001 参考图"]').getBoundingClientRect()
    return `${Math.round(b.x)},${Math.round(b.y)}`
  })

const zoom = await scenario('zoom', clearSel, zoomAct, zoomProbe)
const panSelect = await scenario('pan-select', selectOne, panAct, panProbe)
const panNone = await scenario('pan-none', clearSel, panAct, panProbe)

console.log(`SUMMARY ${CFG.label} zoom=${zoom.toFixed(4)} pan-select=${panSelect.toFixed(4)} pan-none=${panNone.toFixed(4)}`)
EOF

echo "=== $LABEL 汇总 ==="
grep -E '^(ENV|D4|RUN|MEDIAN|SUMMARY)' "$OUT" || true
