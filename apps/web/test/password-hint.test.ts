import { describe, expect, it } from 'vitest'
import { clearHintDismissed, isHintDismissed, markHintDismissed, passwordHintKey } from '@/lib/password-hint'

/** 内存版 storage 桩：只需要被测代码用到的三个方法，外加一个直接改内容的出口 */
function memoryStorage() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    /** 绕过写入口直接塞值：用于构造「存量脏数据」 */
    seed: (k: string, v: string) => void m.set(k, v),
  }
}

describe('改密提醒的会话抑制标记（#84 / 设计 D12）', () => {
  it('键按 userId 分：A 点过出口不能吞掉 B 的提醒', () => {
    const s = memoryStorage()
    expect(markHintDismissed(s, 'usr_a')).toBe(true)
    expect(isHintDismissed(s, 'usr_a')).toBe(true)
    expect(isHintDismissed(s, 'usr_b')).toBe(false)
    expect(passwordHintKey('usr_a')).not.toBe(passwordHintKey('usr_b'))
    // 前缀固定：换个前缀等于让所有存量标记失效（本次从 localStorage 换到 sessionStorage 已是如此）
    expect(passwordHintKey('usr_a')).toBe('motif:password-hint-dismissed:usr_a')
  })

  it('只认 "1"：null / 空串 / 脏数据一律当「没点过」——宁可多提醒，不可误吞', () => {
    const s = memoryStorage()
    expect(isHintDismissed(s, 'usr_a')).toBe(false) // 从未写过
    for (const v of ['', '0', 'true', 'yes', '1 ']) {
      s.seed(passwordHintKey('usr_a'), v)
      expect(isHintDismissed(s, 'usr_a'), `value=${JSON.stringify(v)}`).toBe(false)
    }
    s.seed(passwordHintKey('usr_a'), '1')
    expect(isHintDismissed(s, 'usr_a')).toBe(true)
  })

  it('storage 取不到（null）时不抛：读按「没点过」、写按「没写成」', () => {
    expect(isHintDismissed(null, 'usr_a')).toBe(false)
    expect(markHintDismissed(null, 'usr_a')).toBe(false)
  })

  it('storage 抛异常（禁 cookie / 沙箱 iframe）时同样不抛', () => {
    const boom = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('SecurityError')
      },
      removeItem: () => {
        throw new Error('SecurityError')
      },
    }
    expect(isHintDismissed(boom, 'usr_a')).toBe(false)
    expect(markHintDismissed(boom, 'usr_a')).toBe(false)
    expect(() => clearHintDismissed(boom, 'usr_a')).not.toThrow()
  })

  it('登出清标记：清掉后重新登录会再提醒一次（CONTEXT「会话抑制」的边界是一次登录）', () => {
    const s = memoryStorage()
    markHintDismissed(s, 'usr_a')
    markHintDismissed(s, 'usr_b')
    clearHintDismissed(s, 'usr_a')
    expect(isHintDismissed(s, 'usr_a')).toBe(false)
    // 只清自己那一个键：登出 A 不该影响同机另一个账号的抑制状态
    expect(isHintDismissed(s, 'usr_b')).toBe(true)
    expect(() => clearHintDismissed(null, 'usr_a')).not.toThrow()
  })
})
