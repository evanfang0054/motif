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
 *
 * 已知盲区（刻意接受，不为此把守卫写复杂）：`id={裸变量}`（如 `id={k}` / `id={o.id}`）的取值
 * 静态判不出来 —— 但**裸变量正是期望形态**，所以不判；只有表达式里混了字符串字面量
 * （`id={'status-' + k}` 这类拼接）才报，因为那时取值已经不受控。
 */
const ADMIN_DIR = new URL('../src/app/admin', import.meta.url)

/** 收集 admin 下所有 .tsx —— 不止 page.tsx：筛选控件可能被拆到同目录的组件文件里 */
function adminTsxFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.tsx')) out.push(p)
    }
  }
  walk(ADMIN_DIR.pathname)
  return out.sort()
}

/** 相对 admin/ 的短路径，只用于报错信息可读 */
function rel(f: string): string {
  return f.split('/admin/')[1] ?? f
}

/** 去掉注释：否则「注释里写了一句 `=== 'all'`」就能让哨兵断言假绿 */
function stripComments(src: string): string {
  // 行注释的 `//` 必须处在行首或空白之后 —— 否则 `https://…` 这类字符串会被误切
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/gm, '$1')
}

type IdKind = 'literal' | 'template' | 'expr'

interface ItemId {
  /** 字面量取原文；模板字面量取反引号内原文；表达式取源码片段 */
  raw: string
  kind: IdKind
}

/** 抽出所有 `<ListBox.Item>` 的 id 取值形态（三种写法都要认，漏一种就是一个假绿面） */
function itemIds(src: string): ItemId[] {
  const out: ItemId[] = []
  const re = /<ListBox\.Item\b[^>]*?\bid=(?:"([^"]*)"|\{`([^`]*)`\}|\{([^}]*)\})/g
  for (const m of src.matchAll(re)) {
    if (m[1] !== undefined) out.push({ raw: m[1], kind: 'literal' })
    else if (m[2] !== undefined) out.push({ raw: m[2], kind: 'template' })
    else out.push({ raw: (m[3] ?? '').trim(), kind: 'expr' })
  }
  return out
}

/** 能静态判定的部分：模板字面量只取第一个 `${` 之前（`status-${k}` 的静态前缀就是 `status-`） */
function staticPrefix(id: ItemId): string {
  if (id.kind === 'literal') return id.raw
  if (id.kind === 'template') return id.raw.split('${')[0]
  return ''
}

/** 可疑则返回原因（供断言输出），没问题返回 null */
function suspectReason(id: ItemId): string | null {
  const prefix = staticPrefix(id)
  const prefixed = prefix.match(/^(status|role)-/)
  if (prefixed) return `id 带 \`${prefixed[0]}\` 前缀，回传值会匹配不上接口白名单`
  if (id.kind === 'expr' && /['"`]/.test(id.raw)) return `id 是含字面量的拼接表达式（${id.raw}），取值不受控`
  return null
}

function countMatches(src: string, re: RegExp): number {
  return [...src.matchAll(re)].length
}

describe('管理后台筛选下拉：ListBox.Item 的 id 必须是裸值（#52 防复发）', () => {
  const files = adminTsxFiles()

  it('能扫到 admin 下的文件（守卫本身没瞎）', () => {
    // 防「路径写错 → 扫到 0 个文件 → 断言恒真」这种假绿
    expect(files.length).toBeGreaterThanOrEqual(5)
    expect(files.some((f) => f.includes('feedback'))).toBe(true)
  })

  it('不存在带 `status-` / `role-` 前缀的 id（前缀会让接口判非法后静默不过滤）', () => {
    const bad: string[] = []
    for (const f of files) {
      for (const id of itemIds(readFileSync(f, 'utf8'))) {
        const why = suspectReason(id)
        if (why) bad.push(`${rel(f)}: id=${id.raw} —— ${why}`)
      }
    }
    expect(bad, `这些 id 写法有问题：\n${bad.join('\n')}`).toEqual([])
  })

  it('用了 `all` 哨兵的下拉，**每一个**都要有 `=== \'all\'` 映射回空串', () => {
    // 只改 id 忘了映射 → 选「全部」后 state 会变成字面量 'all'，同样匹配不上接口。
    // 按**个数**比（users 页有两个下拉）：一处映射满足不了两个哨兵。
    const problems: string[] = []
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      const sentinels = itemIds(src).filter((id) => staticPrefix(id) === 'all').length
      if (sentinels === 0) continue
      const mapped = countMatches(stripComments(src), /===\s*'all'/g)
      if (mapped < sentinels) problems.push(`${rel(f)}: ${sentinels} 个 all 哨兵，只有 ${mapped} 处 === 'all'`)
    }
    expect(problems, `哨兵缺映射（选「全部」会写入字面量 'all'）：\n${problems.join('\n')}`).toEqual([])
  })

  it('没有页面仍在用 `(v as XxxFilter) ?? \'\'` 这种「原样写入回传值」的旧写法', () => {
    // 旧写法把回传值直接塞进 state，正是 #52 的成因；修好后应改为显式判哨兵
    const legacy: string[] = []
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      if (/as (Role|Status)Filter\)\s*\?\?\s*''/.test(src)) legacy.push(rel(f))
    }
    expect(legacy, `这些文件仍是旧写法：${legacy.join(', ')}`).toEqual([])
  })

  it('守卫可证伪：字面量前缀写法能被检出', () => {
    const sample = '<ListBox.Item key="status-pending" id="status-pending">待处理</ListBox.Item>'
    expect(itemIds(sample)).toEqual([{ raw: 'status-pending', kind: 'literal' }])
    expect(suspectReason(itemIds(sample)[0])).toMatch(/前缀/)
  })

  it('守卫可证伪：模板字面量的前缀写法也能被检出（静态前缀即可判定）', () => {
    const sample = '<ListBox.Item key={`status-${k}`} id={`status-${k}`}>{v}</ListBox.Item>'
    expect(itemIds(sample)).toEqual([{ raw: 'status-${k}', kind: 'template' }])
    expect(suspectReason(itemIds(sample)[0])).toMatch(/前缀/)
  })

  it('守卫可证伪：表达式里的字符串拼接也能被检出', () => {
    const sample = `<ListBox.Item key={k} id={'status-' + k}>{v}</ListBox.Item>`
    expect(itemIds(sample)).toEqual([{ raw: "'status-' + k", kind: 'expr' }])
    expect(suspectReason(itemIds(sample)[0])).toMatch(/拼接/)
  })

  it('守卫不误报：裸变量的 id 放行（这正是期望形态）', () => {
    for (const sample of ['<ListBox.Item key={k} id={k}>{v}</ListBox.Item>', '<ListBox.Item key={x} id={o.id} textValue={o.label}>v</ListBox.Item>']) {
      expect(itemIds(sample).map(suspectReason)).toEqual([null])
    }
  })

  it('守卫可证伪：只在注释里出现的 `=== \'all\'` 不算映射', () => {
    const sample = "// 这里该写 === 'all' 才对\nconst x = 1"
    expect(countMatches(sample, /===\s*'all'/g)).toBe(1)
    expect(countMatches(stripComments(sample), /===\s*'all'/g)).toBe(0)
  })
})

describe('admin 目录确实存在（防止路径写错导致守卫空转）', () => {
  it('ADMIN_DIR 指向真实目录', () => {
    expect(statSync(ADMIN_DIR.pathname).isDirectory()).toBe(true)
  })
})
