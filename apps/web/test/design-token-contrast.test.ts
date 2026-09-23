import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

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
