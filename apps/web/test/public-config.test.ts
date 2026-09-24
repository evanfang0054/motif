import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MotifStore } from '@motif/db'
import { SETTING_DEFS } from '@/server/settings'
import { PUBLIC_CONFIG_KEYS, readPublicConfig } from '@/server/public-config'

let dir: string
let store: MotifStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'motif-public-config-'))
  store = new MotifStore(join(dir, 't.db'))
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('公开配置（面向未登录用户的白名单）', () => {
  it('白名单里的键全部存在、且都不是密钥类也不是只读键', () => {
    const byKey = new Map(SETTING_DEFS.map((d) => [d.key, d]))
    for (const k of PUBLIC_CONFIG_KEYS) {
      const def = byKey.get(k)
      expect(def, `${k} 不在配置注册表里`).toBeDefined()
      expect(def!.kind, `${k} 是密钥类，不能进公开白名单`).not.toBe('secret')
      expect(def!.readOnly, `${k} 是只读键，不该进公开白名单`).toBeFalsy()
    }
  })

  it('白名单不含注册表里任何一个密钥类键名', () => {
    const secrets = SETTING_DEFS.filter((d) => d.kind === 'secret').map((d) => d.key)
    expect(secrets.length).toBeGreaterThan(0) // 防止「注册表里恰好没有密钥」让本断言空转
    for (const s of secrets) expect(PUBLIC_CONFIG_KEYS as readonly string[]).not.toContain(s)
  })

  it('键未设置时回退默认值（邀请活动 / 提示词增强 / 充值默认关，CDK 兑换默认开）', () => {
    expect(readPublicConfig(store, {})).toEqual({
      inviteRewardEnabled: false,
      inviteRewardCredits: 3,
      inviteRewardMaxInvitees: 3,
      signupBonusCredits: 3,
      llmEnhanceEnabled: false,
      billingEnabled: false,
      cdkRedeemEnabled: true,
    })
  })

  it('键已设置时按库中值返回（库优先于 env）', () => {
    store.setSettings([
      { key: 'INVITE_REWARD_ENABLED', value: 'true' },
      { key: 'INVITE_REWARD_CREDITS', value: '7' },
      { key: 'INVITE_REWARD_MAX_INVITEES', value: '9' },
      { key: 'SIGNUP_BONUS_CREDITS', value: '5' },
      { key: 'LLM_ENHANCE_ENABLED', value: 'true' },
      { key: 'BILLING_ENABLED', value: 'true' },
      { key: 'CDK_REDEEM_ENABLED', value: 'false' },
    ])
    expect(readPublicConfig(store, {})).toEqual({
      inviteRewardEnabled: true,
      inviteRewardCredits: 7,
      inviteRewardMaxInvitees: 9,
      signupBonusCredits: 5,
      llmEnhanceEnabled: true,
      billingEnabled: true,
      cdkRedeemEnabled: false,
    })
  })

  it('两个功能开关的兜底值必须与配置注册表的 defaultHint 一致（前端入口与服务端拒绝不能各说各话）', () => {
    // 本用例钉的是**注册表 ↔ 公开配置**这两处；服务端那两处（startCheckout / redeem 的 resolveBool
    // 兜底）由 billing-checkout 与 services 的用例各自钉住 —— 这里不 import services，
    // 别把这条断言说成「三处全覆盖」（说过一次，被评审当场用「改 services 兜底仍全绿」证伪）。
    const byKey = new Map(SETTING_DEFS.map((d) => [d.key, d]))
    const cfg = readPublicConfig(store, {})
    expect(byKey.get('BILLING_ENABLED')!.defaultHint).toBe(String(cfg.billingEnabled))
    expect(byKey.get('CDK_REDEEM_ENABLED')!.defaultHint).toBe(String(cfg.cdkRedeemEnabled))
  })

  it('库中数值非法时回退默认值（脏配置不影响注册链路）', () => {
    store.setSettings([
      { key: 'INVITE_REWARD_CREDITS', value: 'abc' },
      { key: 'SIGNUP_BONUS_CREDITS', value: '0' },
    ])
    const cfg = readPublicConfig(store, {})
    expect(cfg.inviteRewardCredits).toBe(3)
    expect(cfg.signupBonusCredits).toBe(3)
  })
})
