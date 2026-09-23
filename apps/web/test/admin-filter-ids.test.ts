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
 * 静态判不出来 —— 但**裸变量正是期望形态**，所以不判；只要表达式不是纯取值路径
 * （`id={'status-' + k}` / `id={prefix + k}` / `id={makeId(status)}`）就报，因为那时取值已经不受控。
 *
 * ⚠️ `stripComments` 是**启发式**：它不解析字符串字面量，所以「字符串里恰好出现行注释符或块注释符」
 * 会被误删（当前 admin 源码里没有这种写法）。它只用来避免「注释里的 `=== 'all'` 冒充映射」，
 * 判错的方向是**误红**（报出来会被人看到），不会静默放过。
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

/** 允许的表达式形态：**纯取值路径**（`k` / `o.id` / `a.b.c`）—— 这正是期望的「裸值」 */
const BARE_PATH = /^[A-Za-z_$][\w$]*(\.[\w$]+)*$/

/** 可疑则返回原因（供断言输出），没问题返回 null */
function suspectReason(id: ItemId): string | null {
  const prefix = staticPrefix(id)
  const prefixed = prefix.match(/^(status|role)-/)
  if (prefixed) return `id 带 \`${prefixed[0]}\` 前缀，回传值会匹配不上接口白名单`
  // 裸变量（`id={k}`）是期望形态；但**变量拼接 / 函数调用**（`id={prefix + k}`）取值同样不受控，要报
  if (id.kind === 'expr' && !BARE_PATH.test(id.raw)) {
    return `id 是表达式 \`${id.raw}\`（含拼接或调用），不是单纯的取值路径 —— 静态判不出取值是否受控`
  }
  return null
}

/**
 * 按 `<Select …>` 把源码切成「一个下拉一块」。
 * ⚠️ 必须逐块查：一个 Select 的 `onChange` 与它的 `ListBox.Item` 必然同块，
 * 文件级计数抓不住「映射写进了另一个下拉」这种错位（#52 的原始故障形态）。
 */
function selectBlocks(src: string): string[] {
  const starts: number[] = []
  for (const m of src.matchAll(/<Select[\s>]/g)) starts.push(m.index ?? 0)
  return starts.map((start, i) => src.slice(start, starts[i + 1] ?? src.length))
}

/** 逐下拉检查哨兵映射：返回问题清单（空数组 = 通过） */
function sentinelProblems(name: string, src: string): string[] {
  const problems: string[] = []
  selectBlocks(src).forEach((block, i) => {
    const sentinels = itemIds(block).filter((id) => staticPrefix(id) === 'all').length
    if (sentinels === 0) return
    const mapped = countMatches(block, /===\s*'all'/g)
    if (mapped < sentinels) {
      problems.push(`${name} 第 ${i + 1} 个 Select：${sentinels} 个 all 哨兵，只有 ${mapped} 处 === 'all'`)
    }
  })
  return problems
}

function countMatches(src: string, re: RegExp): number {
  return [...src.matchAll(re)].length
}

describe('管理后台筛选下拉：ListBox.Item 的 id 必须是裸值（#52 防复发）', () => {
  const files = adminTsxFiles()
  /** 一次读盘 + 去注释，三处断言共用同一份口径（两侧口径不一致会制造假红/假绿） */
  const sources = files.map((f) => ({ name: rel(f), src: stripComments(readFileSync(f, 'utf8')) }))

  it('能扫到 admin 下的文件与下拉（守卫本身没瞎）', () => {
    // 防「路径写错 → 扫到 0 个文件 / 0 个 Select → 下面几条断言恒真」这种假绿
    expect(files.length).toBeGreaterThanOrEqual(5)
    expect(files.some((f) => f.includes('feedback'))).toBe(true)
    const blocks = sources.flatMap((s) => selectBlocks(s.src))
    expect(blocks.length).toBeGreaterThanOrEqual(6)
    const sentinels = blocks.flatMap(itemIds).filter((id) => staticPrefix(id) === 'all').length
    expect(sentinels).toBeGreaterThanOrEqual(5)
  })

  it('不存在带 `status-` / `role-` 前缀的 id（前缀会让接口判非法后静默不过滤）', () => {
    const bad: string[] = []
    for (const { name, src } of sources) {
      for (const id of itemIds(src)) {
        const why = suspectReason(id)
        if (why) bad.push(`${name}: id=${id.raw} —— ${why}`)
      }
    }
    expect(bad, `这些 id 写法有问题：\n${bad.join('\n')}`).toEqual([])
  })

  it('**每个**用了 `all` 哨兵的下拉都要有 `=== \'all\'` 映射回空串（逐下拉查，不是文件级计数）', () => {
    // 只改 id 忘了映射 → 选「全部」后 state 会变成字面量 'all'，同样匹配不上接口。
    // users 页有两个下拉，所以必须**按 Select 分块**比：文件级计数会被「映射错位」蒙过去。
    const problems = sources.flatMap((s) => sentinelProblems(s.name, s.src))
    expect(problems, `哨兵缺映射（选「全部」会写入字面量 'all'）：\n${problems.join('\n')}`).toEqual([])
  })

  it('没有页面仍在用 `(v as XxxFilter) ?? \'\'` 这种「原样写入回传值」的旧写法', () => {
    // 旧写法把回传值直接塞进 state，正是 #52 的成因；修好后应改为显式判哨兵
    const legacy = sources.filter((s) => /as (Role|Status)Filter\)\s*\?\?\s*''/.test(s.src)).map((s) => s.name)
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

  it('守卫可证伪：表达式里的字符串拼接、变量拼接、函数调用都能被检出', () => {
    for (const raw of [`'status-' + k`, 'prefix + k', 'makeId(status)']) {
      const sample = `<ListBox.Item key={k} id={${raw}}>{v}</ListBox.Item>`
      expect(itemIds(sample)).toEqual([{ raw, kind: 'expr' }])
      expect(suspectReason(itemIds(sample)[0]), raw).toMatch(/表达式/)
    }
  })

  it('守卫不误报：裸变量 / 成员访问的 id 放行（这正是期望形态）', () => {
    for (const raw of ['k', 'o.id', 'row.status']) {
      const sample = `<ListBox.Item key={x} id={${raw}} textValue={o.label}>v</ListBox.Item>`
      expect(itemIds(sample).map(suspectReason), raw).toEqual([null])
    }
  })

  it('守卫可证伪：映射在文件里「总数够」但错位到另一个下拉时也能被检出', () => {
    // 两个下拉各一个 all 哨兵；第一块里出现两处 `=== 'all'`、第二块一处都没有。
    // 文件级计数 2 >= 2 会放过（假绿），逐下拉计数会红 —— 这正是 #52 的原始故障形态。
    const moved = `
      <Select value={role || 'all'} onChange={(v) => { setRole(v === 'all' ? '' : v); if (v === 'all') setPage(1) }}>
        <ListBox.Item key="all" id="all">全部角色</ListBox.Item>
      </Select>
      <Select value={status || 'all'} onChange={(v) => { setStatus(v as StatusFilter); setPage(1) }}>
        <ListBox.Item key="all" id="all">全部状态</ListBox.Item>
      </Select>`
    expect(countMatches(moved, /===\s*'all'/g)).toBe(2) // 文件级：够
    const problems = sentinelProblems('sample', moved)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('第 2 个 Select')

    // 正对照：各自映射各自的下拉 → 必须通过（否则上一条是恒真断言）
    const ok = moved.replace("setStatus(v as StatusFilter)", "setStatus(v === 'all' ? '' : (v as StatusFilter))")
    expect(sentinelProblems('sample', ok)).toEqual([])
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
