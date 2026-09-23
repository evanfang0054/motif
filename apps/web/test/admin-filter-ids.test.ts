import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 管理后台筛选下拉的**源码级防复发守卫**（issue #52）。
 *
 * 背景：HeroUI v3 的 `Select` 建在 React Aria 之上，`value` 就是 `ListBox.Item` 的 id。
 * 一旦把 id 写成带前缀的形式（`status-pending`），回传值就会带上前缀，而接口白名单只认裸值
 * （`pending`）→ 判非法 → **静默降级为「不过滤」**，不报任何错。这类 bug 在 UI 上表现为
 * 「下拉点了没反应」，**只有真实交互才看得见**，所以除了 ego 实测，再加一层源码守卫防复发。
 *
 * ⚠️ 这条守卫只防「带前缀」这一种已知写法，不能替代 ego 实测 ——
 * 它保证的是「没人把修好的 id 又改回带前缀」，不是「筛选逻辑正确」。
 */
const ADMIN_DIR = new URL('../src/app/admin', import.meta.url)

/** 收集 admin 下所有 page.tsx 的绝对路径 */
function adminPageFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name === 'page.tsx') out.push(p)
    }
  }
  walk(ADMIN_DIR.pathname)
  return out.sort()
}

/** 抽出所有字面量 id（`id="xxx"`）与模板字面量 id（`id={\`xxx\`}`） */
function literalIds(src: string): string[] {
  const out: string[] = []
  for (const m of src.matchAll(/<ListBox\.Item[^>]*?\bid="([^"]*)"/g)) out.push(m[1])
  for (const m of src.matchAll(/<ListBox\.Item[^>]*?\bid=\{`([^`]*)`\}/g)) out.push(m[1])
  return out
}

describe('管理后台筛选下拉：ListBox.Item 的 id 必须是裸值（#52 防复发）', () => {
  const files = adminPageFiles()

  it('能扫到 admin 下的页面（守卫本身没瞎）', () => {
    // 防「路径写错 → 扫到 0 个文件 → 断言恒真」这种假绿
    expect(files.length).toBeGreaterThanOrEqual(5)
    expect(files.some((f) => f.includes('feedback'))).toBe(true)
  })

  it('不存在带 `status-` / `role-` 前缀的 id（前缀会让接口判非法后静默不过滤）', () => {
    const bad: string[] = []
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      for (const id of literalIds(src)) {
        if (/^(status|role)-/.test(id)) bad.push(`${f.split('/admin/')[1]}: id="${id}"`)
      }
    }
    expect(bad, `这些 id 带前缀，回传值会匹配不上接口白名单：\n${bad.join('\n')}`).toEqual([])
  })

  it('用了 `all` 哨兵的页面，onChange 里必须有 `=== \'all\'` 映射回空串', () => {
    // 只改 id 忘了映射 → 选「全部」后 state 会变成字面量 'all'，同样匹配不上接口
    const missing: string[] = []
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      if (!literalIds(src).includes('all')) continue
      if (!src.includes("=== 'all'")) missing.push(f.split('/admin/')[1])
    }
    expect(missing, `这些页面用了 all 哨兵但没有映射回 ''：${missing.join(', ')}`).toEqual([])
  })

  it('没有页面仍在用 `(v as XxxFilter) ?? \'\'` 这种「原样写入回传值」的旧写法', () => {
    // 旧写法把回传值直接塞进 state，正是 #52 的成因；修好后应改为显式判哨兵
    const legacy: string[] = []
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      if (/as (Role|Status)Filter\)\s*\?\?\s*''/.test(src)) legacy.push(f.split('/admin/')[1])
    }
    expect(legacy, `这些页面仍是旧写法：${legacy.join(', ')}`).toEqual([])
  })

  it('守卫可证伪：喂一段带前缀的样例源码必须能被检出', () => {
    const sample = '<ListBox.Item key="status-pending" id="status-pending">待处理</ListBox.Item>'
    expect(literalIds(sample)).toEqual(['status-pending'])
    expect(/^(status|role)-/.test(literalIds(sample)[0])).toBe(true)
  })

  it('守卫可证伪：模板字面量的前缀写法也能被检出', () => {
    const sample = '<ListBox.Item key={`status-${k}`} id={`status-${k}`}>{v}</ListBox.Item>'
    expect(literalIds(sample)).toEqual(['status-${k}'])
  })
})

describe('admin 目录确实存在（防止路径写错导致守卫空转）', () => {
  it('ADMIN_DIR 指向真实目录', () => {
    expect(statSync(ADMIN_DIR.pathname).isDirectory()).toBe(true)
  })
})
