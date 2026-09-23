import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

/**
 * 设计令牌的**文字对比度守卫**（issue #55）。
 *
 * 背景：`--danger-quiet` / `--success-quiet` 是「表面上的语义文字」角色，要求对**它实际落在的底**
 * 达到 WCAG 2.1 AA 的 4.5:1。这类失效没有任何运行时症状（字还在、就是看不清），
 * 历史上两条都栽过：`--success-quiet` 原用 `--success`（2.14:1）、`--danger-quiet` 亮色沿用
 * `--danger`（对 `--danger-soft` 4.20:1）。所以把「算对比度 + 比阈值」下沉成断言。
 *
 * ⚠️ 方向性提醒（踩过一次）：提升文字对比度只有「**文字压深**」或「底色变浅」两个方向 ——
 * 把浅彩底压深会**降低**比值（底越靠近文字色，分子越小）。issue #55 最初的「压深底色」方案
 * 实算后是 3.59:1，比原来更差。
 */

/** WCAG 2.1 相对亮度 */
function luminance(hex: string): number {
  const f = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  const n = parseInt(hex.replace('#', ''), 16)
  return 0.2126 * f(((n >> 16) & 255) / 255) + 0.7152 * f(((n >> 8) & 255) / 255) + 0.0722 * f((n & 255) / 255)
}

/** 对比度（谁亮谁当分子，与调用顺序无关） */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** 去掉注释：注释里也写着令牌名，不剥会解析到注释里的取值 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '')
}

/**
 * 取**所有**匹配该选择器的块里的 `--token: value` 并合并。
 * ⚠️ 必须合并而不是只取第一块：同一个选择器在本文件里出现多次
 * （例如 `html[data-theme="dark"]` 既有基础令牌块、又有 HeroUI 桥接块，
 *  `--danger-quiet` 只在后者里）。
 */
function blockTokens(css: string, selector: RegExp): Record<string, string> {
  const out: Record<string, string> = {}
  let hit = 0
  for (const m of stripComments(css).matchAll(selector)) {
    hit += 1
    for (const line of m[1].split('\n')) {
      const kv = line.match(/^\s*(--[\w-]+)\s*:\s*([^;]+);/)
      if (kv) out[kv[1]] = kv[2].trim()
    }
  }
  if (!hit) throw new Error(`找不到选择器块：${selector}`)
  return out
}

const CSS = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8')
/** 基准块（`--danger` 等基令牌定义在这里）+ 亮色覆盖块 */
const BASE = blockTokens(CSS, /^:root\s*\{([\s\S]*?)\}/gm)
const LIGHT = { ...BASE, ...blockTokens(CSS, /^:root,\s*\[data-theme="light"\]\s*\{([\s\S]*?)\}/gm) }
const DARK = { ...BASE, ...blockTokens(CSS, /^html\[data-theme="dark"\]\s*\{([\s\S]*?)\}/gm) }

/** 解析 `var(--x)` 引用（最多下钻几层，防环） */
function resolve(tokens: Record<string, string>, name: string, depth = 0): string {
  const raw = tokens[name]
  if (!raw) throw new Error(`令牌不存在：${name}`)
  const ref = raw.match(/^var\((--[\w-]+)\)$/)
  if (ref && depth < 5) return resolve(tokens, ref[1], depth + 1)
  return raw
}

/**
 * HeroUI 主题文件（`@heroui/styles` 的默认主题变量）。
 * 用来把「按钮文字色」等 HeroUI 侧取值**读出来**，而不是在断言里写死字面量 ——
 * 见 `buttonForeground()` 的说明。
 */
const HERUI_THEME = readFileSync(
  createRequire(import.meta.url).resolve('@heroui/styles/themes/default/variables.css'),
  'utf8'
)

/** 从 HeroUI 主题文件里取某个令牌的原始值（不解析 var，只取字面量） */
function heroUiToken(name: string): string {
  const m = stripComments(HERUI_THEME).match(new RegExp(`^\\s*${name}\\s*:\\s*([^;]+);`, 'm'))
  if (!m) throw new Error(`HeroUI 主题里找不到令牌：${name}（升级后改名了？）`)
  return m[1].trim()
}

/**
 * 从 HeroUI 主题文件里取**某个主题块**的令牌表。
 * ⚠️ 同一个名字在亮/暗块里取值不同（如 `--default`），`heroUiToken` 只取第一处，
 * 所以按主题取值的令牌必须用本函数。
 */
function heroUiThemeTokens(block: 'light' | 'dark'): Record<string, string> {
  // 亮块与暗块各以一行 `:host([data-theme="…"]) {` 收尾，拿它当锚点最稳
  const sel = block === 'light' ? ':host\\(\\[data-theme="default"\\]\\)' : ':host\\(\\[data-theme="dark"\\]\\)'
  return blockTokens(HERUI_THEME, new RegExp(`^\\s*${sel}\\s*\\{([\\s\\S]*?)\\n\\s*\\}`, 'gm'))
}

/** oklch → sRGB hex（本文件只需处理中性色，即 C=0 时也走同一套矩阵） */
function oklchToHex(l: number, c: number, hDeg: number): string {
  const h = (hDeg * Math.PI) / 180
  const a = c * Math.cos(h)
  const b = c * Math.sin(h)
  const l3 = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m3 = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s3 = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  const enc = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055)
  return (
    '#' +
    [
      4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
      -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
      -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
    ]
      .map((v) => Math.round(Math.min(1, Math.max(0, enc(v))) * 255).toString(16).padStart(2, '0'))
      .join('')
  )
}

/** 6 位 hex → 0..1 的 [r,g,b] */
function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

/**
 * `color-mix(in oklab, A p%, B q%)` 的实算（两个输入都必须是不透明 hex）。
 * 用来复现 HeroUI 的派生值 —— 尤其 `--accent-hover` 的默认公式，见下面那条反向锚点。
 */
function mixOklab(hexA: string, p: number, hexB: string, q: number): string {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const enc = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055)
  const toOklab = ([r, g, b]: [number, number, number]) => {
    r = lin(r)
    g = lin(g)
    b = lin(b)
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
    return [
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ]
  }
  const wa = p / (p + q)
  const wb = q / (p + q)
  const a = toOklab(hexToRgb(hexA))
  const b = toOklab(hexToRgb(hexB))
  const [L, A, B] = a.map((v, i) => v * wa + b[i] * wb)
  const l3 = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3
  const m3 = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3
  const s3 = (L - 0.0894841775 * A - 1.291485548 * B) ** 3
  return (
    '#' +
    [
      4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
      -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
      -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
    ]
      .map((v) => Math.round(Math.min(1, Math.max(0, enc(v))) * 255).toString(16).padStart(2, '0'))
      .join('')
  )
}

/**
 * 主按钮文字色 = HeroUI 的 `--accent-foreground`（默认主题里指向 `--snow`）。
 *
 * **刻意不写死 `#fcfcfc`**：写死的话，HeroUI 升级改了按钮文字色，断言会拿着旧值继续「绿」，
 * 而真实界面早已不是那个颜色 —— 这正是 review 指出的缺口。这里把
 * `--accent-foreground → --snow → oklch(...) → hex` 整条链读出来，值变了断言就跟着变。
 */
function buttonForeground(): string {
  const raw0 = heroUiToken('--accent-foreground')
  const ref = raw0.match(/^var\((--[\w-]+)\)$/)
  return parseOklch(ref ? heroUiToken(ref[1]) : raw0)
}

/** 解析 `oklch(L C H)` / `oklch(L% C H)`（可选 `deg`）→ hex */
function parseOklch(value: string): string {
  const m = value.match(/^oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?\s*\)$/)
  if (!m) throw new Error(`看不懂的 oklch：${value}（本函数只实现了 oklch(L C H) 形式）`)
  const L = m[1].endsWith('%') ? Number(m[1].slice(0, -1)) / 100 : Number(m[1])
  return oklchToHex(L, Number(m[2]), Number(m[3]))
}

/** 解析 `color-mix(in oklab, var(--x) p%, var(--y) q%)` 里的 p / q */
function mixWeights(value: string): [number, number] {
  const m = value.match(/color-mix\(\s*in oklab\s*,\s*var\(--[\w-]+\)\s+([\d.]+)%\s*,\s*var\(--[\w-]+\)\s+([\d.]+)%\s*\)/)
  if (!m) throw new Error(`看不懂的 color-mix：${value}`)
  return [Number(m[1]), Number(m[2])]
}

const AA = 4.5

describe('文字对比度守卫（#55）', () => {
  it('辅助函数自检（不是对令牌的守护，只是保证算得对）', () => {
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 1)
    expect(contrast('#a63a3a', '#a63a3a')).toBeCloseTo(1, 5)
  })

  it('⚠️ 亮色 --danger-quiet 不再是 --danger 的别名（改回别名就会丢掉 4.5 达标）', () => {
    // 修前它就是 `var(--danger)` → 4.20:1。这条断言**随 CSS 变化**，改回去立刻红。
    expect(resolve(LIGHT, '--danger-quiet')).not.toBe(resolve(LIGHT, '--danger'))
    // 阈值标定：4.5 这条线确实判得死历史失败值（否则整套断言可能在放水）。
    expect(contrast('#c64545', '#f9ecec')).toBeLessThan(AA)
  })

  it('亮色：--danger-quiet 对 --danger-soft ≥4.5（#55 本体）', () => {
    const fg = resolve(LIGHT, '--danger-quiet')
    const bg = resolve(LIGHT, '--danger-soft')
    expect(contrast(fg, bg), `--danger-quiet ${fg} vs --danger-soft ${bg}`).toBeGreaterThanOrEqual(AA)
  })

  it('亮色：--success-quiet 对 --success-soft ≥4.5（#29 的修复不能回退）', () => {
    const fg = resolve(LIGHT, '--success-quiet')
    const bg = resolve(LIGHT, '--success-soft')
    expect(contrast(fg, bg), `--success-quiet ${fg} vs --success-soft ${bg}`).toBeGreaterThanOrEqual(AA)
  })

  it('亮色：--danger-quiet 对**它可能落在的每个表面**都 ≥4.5（不止 alert 那一处）', () => {
    const fg = resolve(LIGHT, '--danger-quiet')
    // 消费点：alert 底 / 面板 / 侧栏 / 三级面 / 悬停面 / 激活面
    const surfaces = ['--danger-soft', '--surface-primary', '--surface-secondary', '--surface-tertiary', '--surface-hover', '--surface-active']
    for (const s of surfaces) {
      const bg = resolve(LIGHT, s)
      expect(contrast(fg, bg), `--danger-quiet ${fg} vs ${s} ${bg}`).toBeGreaterThanOrEqual(AA)
    }
  })

  it('亮色：没有哪个 --surface-* 比 --surface-active 更暗（拿它当最坏情况才成立）', () => {
    // 上面那张清单是「最坏情况」推断 —— 把它变成可证伪的断言：
    // 将来新增更暗的表面时这里会红，提示把它补进清单并复核对比度。
    const worst = luminance(resolve(LIGHT, '--surface-active'))
    const surfaces = Object.keys(LIGHT).filter((k) => k.startsWith('--surface-'))
    // ⚠️ 先挡住「算不了亮度就被静默跳过」这条假绿路径：`filter` 只留 6 位 hex，
    // 而 3 位简写 / color-mix / 带 alpha 的值都会解析成非 6 位 hex。
    // 它们必须显式列出来人工复核，不能悄悄从比对里消失。
    const opaque = surfaces.filter((k) => /^#[0-9a-f]{6}$/i.test(resolve(LIGHT, k)))
    const unmeasurable = surfaces.filter((k) => !opaque.includes(k))
    expect(
      unmeasurable,
      `这些 --surface-* 不是 6 位 hex，无法自动比对亮度，请人工复核后再决定去留：${unmeasurable.join(', ')}`
    ).toEqual([])
    const darker = opaque.filter((k) => luminance(resolve(LIGHT, k)) < worst)
    expect(darker, `这些表面比 --surface-active 更暗，需复核 --danger-quiet 的对比度：${darker.join(', ')}`).toEqual([])
  })

  it('暗色：--danger-quiet / --success-quiet 对各自落点 ≥4.5（暗色一直达标，别改坏）', () => {
    // ⚠️ 暗色只钉**实际消费到**的表面。globals.css 里已写明约束：暗色 --danger-quiet
    // 不允许落在 --surface-tertiary / --surface-active 上（实测 4.22 / 4.26，未达 AA）。
    // 新增消费点若落在更暗的面上，必须先把本值提亮，再把那个面加进下面的清单。
    for (const [fgName, bgName] of [
      ['--danger-quiet', '--danger-soft'],
      ['--danger-quiet', '--surface-primary'],
      ['--danger-quiet', '--surface-secondary'],
      ['--success-quiet', '--success-soft'],
      ['--success-quiet', '--surface-primary'],
    ]) {
      const fg = resolve(DARK, fgName)
      const bg = resolve(DARK, bgName)
      expect(contrast(fg, bg), `${fgName} ${fg} vs ${bgName} ${bg}`).toBeGreaterThanOrEqual(AA)
    }
  })

  it('暗色：被禁用的两个更暗表面确实不达标 —— 与 globals.css 的约束注释同源', () => {
    // 这条不是在守护「达标」，而是把**注释里的约束**钉成可执行事实：
    // 哪天有人提亮了暗色 --danger-quiet（好事），这里会红，提醒他同步删掉
    // globals.css 里那句「不要放在 --surface-tertiary / --surface-active 上」。
    for (const bgName of ['--surface-tertiary', '--surface-active']) {
      const fg = resolve(DARK, '--danger-quiet')
      const bg = resolve(DARK, bgName)
      expect(contrast(fg, bg), `${fg} vs ${bg}`).toBeLessThan(AA)
    }
  })

  it('解析器会剥掉注释里的同名声明（不剥就会取到注释里的值）', () => {
    // 反证式样本：把「同名声明」放进**真声明之后**的块注释里 —— 不剥注释时它会被后读到、覆盖真值。
    const sample = ':root {\n  --danger-quiet: #a63a3a;\n  /*\n  --danger-quiet: #000000;\n  */\n}'
    expect(blockTokens(sample, /^:root\s*\{([\s\S]*?)\}/gm)['--danger-quiet']).toBe('#a63a3a')
  })
})

/**
 * 主按钮文字对比度守卫（issue #72）。
 *
 * 主按钮（`立即生成` / `开始生成` / `免费注册` …）是 HeroUI `Button` 的 primary 变体：
 * 底色 `--button-bg: var(--accent)`，文字 `--button-fg: var(--accent-foreground)`
 * （`@heroui/styles/dist/components/button.css:97-100`）。项目把 `--accent` 桥接成珊瑚后，
 * 近白文字压珊瑚只有 **3.19:1**，低于正文 AA —— 这是**有现网症状**的缺口（每个页面都中），
 * 所以连同 hover 一起钉成断言。
 */
describe('主按钮文字对比度守卫（#72）', () => {
  const BUTTON_FG = buttonForeground()

  it('文字色确实是从 HeroUI 主题读出来的（换算器自检，不是对令牌的守护）', () => {
    // 换算器对中性色的还原：oklch(0.9911 0 0) 就是浏览器里实测到的 rgb(252,252,252)。
    expect(oklchToHex(0.9911, 0, 0)).toBe('#fcfcfc')
    // 读取链本身：--accent-foreground 必须仍指向 --snow。
    expect(heroUiToken('--accent-foreground')).toBe('var(--snow)')
    // ⚠️ 这条是**漂移警报**：HeroUI 一旦改了按钮文字色，这里会红 —— 请重新在浏览器实测
    //    （而不是把本行改成新值了事，因为整个「3.19 未达标」的结论建立在近白文字上）。
    expect(BUTTON_FG, 'HeroUI 的按钮文字色变了，需重新实测并复核全部结论').toBe('#fcfcfc')
  })

  it('亮色：--accent 与 --accent-hover 对按钮文字都 ≥4.5', () => {
    expect(contrast(BUTTON_FG, resolve(LIGHT, '--accent'))).toBeGreaterThanOrEqual(AA)
    expect(contrast(BUTTON_FG, resolve(LIGHT, '--accent-hover'))).toBeGreaterThanOrEqual(AA)
  })

  it('暗色：同上（暗下按钮文字同为近白，不能只在亮色修）', () => {
    expect(contrast(BUTTON_FG, resolve(DARK, '--accent'))).toBeGreaterThanOrEqual(AA)
    expect(contrast(BUTTON_FG, resolve(DARK, '--accent-hover'))).toBeGreaterThanOrEqual(AA)
  })

  it('⚠️ 品牌珊瑚 --brand-warm 必须仍**不**达标（证明上面两条不是恒真）', () => {
    // 反向锚点：把 --accent 改回 var(--brand-warm) 时上面会红，而这条会绿 —— 两条一起才说明
    // 「阈值卡在了正确的位置」，而不是随便取个颜色都能过。
    // 锚在 `--brand-warm` 令牌上而不是写死 #cc785c：品牌色若被改，锚点跟着走，不会悄悄失效。
    expect(contrast(BUTTON_FG, resolve(LIGHT, '--brand-warm'))).toBeLessThan(AA)
  })

  it('⚠️ --accent-hover 必须显式定义（HeroUI 默认往浅色混，会把 hover 比值压到 4.5 以下）', () => {
    // HeroUI 默认 `--accent-hover: color-mix(in oklab, var(--accent) 90%, var(--accent-foreground) 10%)`
    // —— 是**往文字色（近白）混**，底变浅 ⇒ hover 比静止态更糊。
    // ⚠️ 本文件的令牌表只从 globals.css 建，**不含 HeroUI 的派生值**：真把这两行删掉，
    //    `resolve` 会抛「令牌不存在」而不是静默回落到派生值。所以下面那条断言才是「为什么必须显式定」的证据。
    for (const [name, tokens] of [['亮色', LIGHT], ['暗色', DARK]] as const) {
      const hover = resolve(tokens, '--accent-hover')
      expect(hover, `${name} --accent-hover 不该是 color-mix 派生值`).not.toContain('color-mix')
      expect(contrast(BUTTON_FG, hover), `${name} hover ${hover}`).toBeGreaterThanOrEqual(AA)
    }
  })

  it('⚠️ 按 HeroUI 默认公式派生出来的 hover 必须仍**不**达标（证明显式覆盖是必要的）', () => {
    // 反向锚点之二：复算 HeroUI 的默认派生 —— #b05a38 往 #fcfcfc 混 10% 得 #b96a4c，只有 3.91。
    // 把这条与上一条一起看，才说明 `--accent-hover` 那行不是装饰，而是**必须**。
    const derived = mixOklab(resolve(LIGHT, '--accent'), 90, BUTTON_FG, 10)
    expect(derived, 'HeroUI 默认派生公式若变了，这里的 3.91 结论要重算').toBe('#b96a4c')
    expect(contrast(BUTTON_FG, derived)).toBeLessThan(AA)
  })
})

/**
 * 聚焦环守卫（#72 的连带项）。
 *
 * HeroUI 的聚焦环走 `--focus`，而默认主题里 `--focus: var(--accent)`
 * （`themes/default/variables.css:116/248`，经 `focus-ring` 工具类的 `ring-focus` 消费）。
 * 所以压深 `--accent` 会连带压深聚焦环 —— 亮色因此**变好**，暗色会**跌破**非文字图形的 3:1。
 * 故暗色块把 `--focus` 显式接回 `--brand-warm`（= 改动前的取值）。这里把它钉住。
 */
describe('聚焦环对比度守卫（#72 连带）', () => {
  /** WCAG 2.1 SC 1.4.11：非文字图形（含焦点指示）≥3:1 */
  const NON_TEXT = 3

  it('亮/暗两态：--focus 对它可能落在的每个表面都 ≥3（暗色是最容易破的一侧）', () => {
    for (const [name, tokens] of [['亮色', LIGHT], ['暗色', DARK]] as const) {
      const ring = resolve(tokens, '--focus')
      const surfaces = ['--background', '--surface-primary', '--surface-secondary', '--surface-tertiary', '--surface-hover', '--surface-active']
      for (const s of surfaces) {
        const bg = resolve(tokens, s)
        expect(contrast(ring, bg), `${name} 聚焦环 ${ring} vs ${s} ${bg}`).toBeGreaterThanOrEqual(NON_TEXT)
      }
    }
  })

  it('⚠️ 暗色 --focus 必须**不**等于 --accent（跟着变深就会在 tertiary/active 上跌破 3:1）', () => {
    // 反向锚点：这条与上一条一起，说明暗色那句显式覆盖是必须的，而不是随手抄的。
    const accent = resolve(DARK, '--accent')
    expect(resolve(DARK, '--focus')).not.toBe(accent)
    // 若真跟着 --accent 走，暗色会有表面不达标（实测 --surface-tertiary 2.74 / --surface-active 2.76）。
    expect(contrast(accent, resolve(DARK, '--surface-tertiary'))).toBeLessThan(NON_TEXT)
  })
})

/**
 * `secondary` 变体按钮的文字守卫（#72 连带）。
 *
 * `variant="secondary"` 的 Button（全站 ~20 处）底色 `--default`、文字 `--accent-soft-foreground`
 * （`button.css:104-107`）—— 文字也是从 `--accent` 派生的，所以同样被本次改动波及。
 * 两个值项目都**没有**桥接（都在 HeroUI 主题里），且 `--default` 亮暗取值不同，
 * 故这里全部从 HeroUI 读、权重也从 HeroUI 的 color-mix 公式里解析，不写死。
 */
describe('secondary 按钮文字对比度守卫（#72 连带）', () => {
  const CASES = [
    ['亮色', LIGHT, 'light'],
    ['暗色', DARK, 'dark'],
  ] as const

  /** secondary 按钮的「文字 / 底色 / 比值」 */
  function secondaryButton(tokens: Record<string, string>, block: 'light' | 'dark') {
    const hero = heroUiThemeTokens(block)
    const [p, q] = mixWeights(hero['--accent-soft-foreground'])
    return {
      // 文字 = color-mix(--accent p%, --foreground q%)，取**项目**的 accent / foreground
      fg: mixOklab(resolve(tokens, '--accent'), p, resolve(tokens, '--foreground'), q),
      bg: parseOklch(hero['--default']),
    }
  }

  it('亮/暗两态：secondary 按钮文字对 --default 都 ≥4.5', () => {
    for (const [name, tokens, block] of CASES) {
      const { fg, bg } = secondaryButton(tokens, block)
      expect(contrast(fg, bg), `${name} secondary 文字 ${fg} vs --default ${bg}`).toBeGreaterThanOrEqual(AA)
    }
  })

  it('⚠️ 旧的品牌珊瑚同样会把它压到更差（暗色那一侧），说明这条断言不是恒真', () => {
    // 反向锚点：暗色 secondary 文字原为 6.41，改后 4.96 —— 是回落但仍在 AA 之上。
    // 这里证明「换回珊瑚」并不总是更好：亮色会掉回 4.83，暗色升到 6.41，两侧方向相反。
    // 与主按钮那条一样锚在 `--brand-warm` 令牌上，不写死 #cc785c。
    const hero = heroUiThemeTokens('dark')
    const [p, q] = mixWeights(hero['--accent-soft-foreground'])
    const fgOld = mixOklab(resolve(DARK, '--brand-warm'), p, resolve(DARK, '--foreground'), q)
    const bg = parseOklch(hero['--default'])
    expect(contrast(fgOld, bg)).toBeGreaterThan(contrast(secondaryButton(DARK, 'dark').fg, bg))
  })
})
