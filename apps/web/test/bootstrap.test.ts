import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MotifStore } from '@motif/db'
import { ADMIN_CREDENTIALS_FILE, ensureRootAccount } from '@/server/bootstrap'
import { login } from '@/server/services'

let dir: string
let store: MotifStore

function deps(env: Record<string, string> = {}) {
  return { store, dataDir: dir, env: env as NodeJS.ProcessEnv }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'motif-bootstrap-'))
  store = new MotifStore(join(dir, 't.db'))
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('管理员引导', () => {
  it('空库时创建 root，置 mustChangePassword，写凭据文件且权限 0600', () => {
    const res = ensureRootAccount(deps())
    expect(res.created).toBe(true)
    expect(res.credentialsWritten).toBe(true)
    expect(res.email).toBe('admin@motif.local')

    const root = store.getUserByEmail('admin@motif.local')!
    expect(root.role).toBe('root')
    expect(root.status).toBe('active')
    expect(root.mustChangePassword).toBe(true)
    expect(root.credits).toBe(0)

    const file = join(dir, ADMIN_CREDENTIALS_FILE)
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).toContain(res.password!)
    expect(statSync(file).mode & 0o777).toBe(0o600)

    // 契约 A3：凭据文件里的密码必须真的能登录，而不只是「文件里含这串字符」
    expect(login(store, 'admin@motif.local', res.password!).id).toBe(root.id)
  })

  it('凭据文件只在创建那一刻写：再次引导不重写（内容与 mtime 均不变）', async () => {
    const first = ensureRootAccount(deps())
    const file = join(dir, ADMIN_CREDENTIALS_FILE)
    const beforeContent = readFileSync(file, 'utf8')
    const beforeMtime = statSync(file).mtimeMs

    // 模拟用户已自行改密；同时放大时间差，避免 mtime 粒度导致假阴
    const root = store.getUserByEmail('admin@motif.local')!
    store.updateUserPassword(root.id, 'scrypt$deadbeef$deadbeef')
    await new Promise((r) => setTimeout(r, 1100))

    const second = ensureRootAccount(deps())
    expect(second.created).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe(beforeContent)
    expect(statSync(file).mtimeMs).toBe(beforeMtime)
    expect(beforeContent).toContain(first.password!)
  })

  it('库中已有 root 但凭据文件被删：不新建账号', () => {
    ensureRootAccount(deps())
    unlinkSync(join(dir, ADMIN_CREDENTIALS_FILE))
    const res = ensureRootAccount(deps())
    expect(res.created).toBe(false)
    expect(store.countUsersByRole('root')).toBe(1)
  })

  it('库中无 root 但凭据文件已存在：仍创建账号并重写文件', () => {
    writeFileSync(join(dir, ADMIN_CREDENTIALS_FILE), '旧的残留内容')
    const res = ensureRootAccount(deps())
    expect(res.created).toBe(true)
    expect(readFileSync(join(dir, ADMIN_CREDENTIALS_FILE), 'utf8')).toContain(res.password!)
  })

  it('MOTIF_SKIP_ADMIN_BOOTSTRAP=1 时完全不创建', () => {
    const res = ensureRootAccount(deps({ MOTIF_SKIP_ADMIN_BOOTSTRAP: '1' }))
    expect(res.created).toBe(false)
    expect(res.password).toBeNull()
    expect(store.countUsersByRole('root')).toBe(0)
    expect(existsSync(join(dir, ADMIN_CREDENTIALS_FILE))).toBe(false)
  })

  it('env 提供密码与邮箱时以其为准，凭据文件写的就是 env 密码', () => {
    const res = ensureRootAccount(deps({ MOTIF_ADMIN_EMAIL: 'ops@example.com', MOTIF_ADMIN_PASSWORD: 'My-Own-Pass-123' }))
    expect(res.email).toBe('ops@example.com')
    expect(res.password).toBe('My-Own-Pass-123')
    const lines = readFileSync(join(dir, ADMIN_CREDENTIALS_FILE), 'utf8').split('\n')
    expect(lines.find((l) => l.startsWith('密码:'))).toBe('密码: My-Own-Pass-123')
  })

  it('未提供 env 密码时，凭据文件里写的是生成的随机强密码', () => {
    const res = ensureRootAccount(deps())
    expect(res.password!.length).toBeGreaterThanOrEqual(20)
    // 断言「密码:」那一行的实际取值，而不是检查环境变量名（后者恒为真，是空断言）
    const lines = readFileSync(join(dir, ADMIN_CREDENTIALS_FILE), 'utf8').split('\n')
    expect(lines.find((l) => l.startsWith('密码:'))).toBe(`密码: ${res.password}`)
  })

  it('dataDir 不存在时自动创建（凭据交付不因目录缺失而静默失败）', () => {
    const fresh = join(dir, 'nested', 'deeper')
    const res = ensureRootAccount({ store, dataDir: fresh, env: {} as NodeJS.ProcessEnv })
    expect(res.created).toBe(true)
    expect(res.credentialsWritten).toBe(true)
    expect(existsSync(join(fresh, ADMIN_CREDENTIALS_FILE))).toBe(true)
  })

  it('内部抛错时不向上冒泡（不阻断进程启动）', () => {
    store.close()
    expect(() => ensureRootAccount(deps())).not.toThrow()
  })
})
