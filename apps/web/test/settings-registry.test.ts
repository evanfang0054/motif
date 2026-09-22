import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MotifStore } from '@motif/db'
import {
  SETTING_DEFS,
  configHealth,
  maskSecret,
  readSettingsView,
  resolveConfigValues,
  resolveSetting,
  seedSettings,
  writeSettings,
} from '@/server/settings'

let dir: string
let store: MotifStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'motif-settings-reg-'))
  store = new MotifStore(join(dir, 't.db'))
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('maskSecret（密钥永不回显）', () => {
  it('长密钥保留前 3 与后 4', () => {
    expect(maskSecret('sk-1234567890abcdef')).toBe('sk-••••••••••••cdef')
  })

  it('8 位及以内全部遮蔽 —— 否则「前 3 + 后 4」等于原样回显', () => {
    for (const v of ['a', 'ab', 'abcdefgh']) {
      expect(maskSecret(v)).toBe('•'.repeat(v.length))
      expect(maskSecret(v)).not.toContain(v)
    }
  })

  it('任何长度下掩码都不等于原值', () => {
    // 正对照：如果 maskSecret 直接 return value，这条会红
    for (let n = 1; n <= 40; n++) {
      const v = 'x'.repeat(n)
      expect(maskSecret(v)).not.toBe(v)
    }
  })

  it('空串返回空串（未设置与「掩码为空」要能区分）', () => {
    expect(maskSecret('')).toBe('')
  })
})

describe('取值解析：DB 优先，回退 env', () => {
  it('DB 有值就用 DB 的值', () => {
    store.setSetting('IMAGE_MODEL', 'db-model')
    expect(resolveSetting(store, { IMAGE_MODEL: 'env-model' }, 'IMAGE_MODEL')).toBe('db-model')
  })

  it('DB 没有该键时回退 env', () => {
    expect(resolveSetting(store, { IMAGE_MODEL: 'env-model' }, 'IMAGE_MODEL')).toBe('env-model')
  })

  it('都没有时返回 null（不是空串）', () => {
    expect(resolveSetting(store, {}, 'IMAGE_MODEL')).toBeNull()
  })

  it('只读键恒取 env，即使 DB 里有同名记录也不读', () => {
    store.setSetting('MOTIF_DATA_DIR', '/from/db')
    const values = resolveConfigValues(store, { MOTIF_DATA_DIR: '/from/env' })
    expect(values.MOTIF_DATA_DIR).toBe('/from/env')
  })
})

describe('播种（只播非空值、已存在的键永不覆盖）', () => {
  it('把 env 里的非空值写进 DB，并返回本次新写入的键', () => {
    const seeded = seedSettings(store, { IMAGE_MODEL: 'gpt-image-2', IMAGE_API_KEY: 'sk-x' })
    expect(seeded.sort()).toEqual(['IMAGE_API_KEY', 'IMAGE_MODEL'])
    expect(store.getSetting('IMAGE_MODEL')).toBe('gpt-image-2')
  })

  it('env 里为空串或缺席的键一律不播 —— 播空值会把「未设置」伪装成「已设置」', () => {
    seedSettings(store, { IMAGE_MODEL: '', MAIL_FROM: undefined })
    expect(store.getSetting('IMAGE_MODEL')).toBeNull()
    expect(store.getSetting('MAIL_FROM')).toBeNull()
  })

  it('已存在的键在 env 变化后重新播种仍保持库中的值', () => {
    seedSettings(store, { IMAGE_MODEL: 'first' })
    const second = seedSettings(store, { IMAGE_MODEL: 'second' })
    expect(second).not.toContain('IMAGE_MODEL')
    expect(store.getSetting('IMAGE_MODEL')).toBe('first')
  })

  it('只读键永不入库', () => {
    seedSettings(store, { MOTIF_DATA_DIR: '/data', MOTIF_DB_FILE: '/data/x.db' })
    expect(store.listSettings()).toEqual([])
  })

  it('注册表里每个可写键都能被播种（正对照：防止往注册表加了键却漏进播种循环）', () => {
    const env = Object.fromEntries(SETTING_DEFS.filter((d) => !d.readOnly).map((d) => [d.key, `v-${d.key}`]))
    const seeded = seedSettings(store, env)
    expect(seeded.sort()).toEqual(
      SETTING_DEFS.filter((d) => !d.readOnly)
        .map((d) => d.key)
        .sort()
    )
  })
})

describe('读取视图（密钥只回掩码）', () => {
  it('密钥项 value 恒为 null，只给掩码与已设置标记', () => {
    store.setSetting('IMAGE_API_KEY', 'sk-1234567890abcdef')
    const view = readSettingsView(store, {})
    const item = view.find((v) => v.key === 'IMAGE_API_KEY')!
    expect(item.value).toBeNull()
    expect(item.masked).toBe('sk-••••••••••••cdef')
    expect(item.isSet).toBe(true)
  })

  it('非密钥项正常返回可读值（正对照）', () => {
    store.setSetting('IMAGE_MODEL', 'gpt-image-2')
    const item = readSettingsView(store, {}).find((v) => v.key === 'IMAGE_MODEL')!
    expect(item.value).toBe('gpt-image-2')
    expect(item.masked).toBeNull()
  })

  it('source 区分 db / env / unset', () => {
    store.setSetting('IMAGE_MODEL', 'x')
    const view = readSettingsView(store, { MAIL_FROM: 'a@b.co' })
    expect(view.find((v) => v.key === 'IMAGE_MODEL')!.source).toBe('db')
    expect(view.find((v) => v.key === 'MAIL_FROM')!.source).toBe('env')
    expect(view.find((v) => v.key === 'SENDGRID_API_KEY')!.source).toBe('unset')
  })

  it('只读项被标记为 readOnly', () => {
    expect(readSettingsView(store, {}).filter((v) => v.readOnly).map((v) => v.key)).toEqual([
      'MOTIF_DATA_DIR',
      'MOTIF_DB_FILE',
    ])
  })

  it('危险区项被标记为 danger', () => {
    expect(readSettingsView(store, {}).filter((v) => v.danger).map((v) => v.key)).toEqual([
      'MOTIF_EXPOSE_DEV_CODE',
      'PAYMENT_CHANNEL',
    ])
  })
})

describe('额度与奖励分组（credits）', () => {
  it('四个键存在、kind 与默认值正确、且既非只读也非危险区', () => {
    const defs = SETTING_DEFS.filter((d) => d.group === 'credits')
    expect(defs.map((d) => d.key).sort()).toEqual([
      'INVITE_REWARD_CREDITS',
      'INVITE_REWARD_ENABLED',
      'INVITE_REWARD_MAX_INVITEES',
      'SIGNUP_BONUS_CREDITS',
    ])
    const byKey = Object.fromEntries(defs.map((d) => [d.key, d]))
    expect(byKey.INVITE_REWARD_ENABLED.kind).toBe('boolean')
    expect(byKey.INVITE_REWARD_ENABLED.defaultHint).toBe('false')
    for (const k of ['INVITE_REWARD_CREDITS', 'INVITE_REWARD_MAX_INVITEES', 'SIGNUP_BONUS_CREDITS']) {
      expect(byKey[k].kind).toBe('number')
      expect(byKey[k].defaultHint).toBe('3')
    }
    // 既有「只读精确集合」「危险区精确集合」两条断言是回归护栏：新键两者都不能进
    for (const d of defs) {
      expect(d.readOnly).toBeFalsy()
      expect(d.danger).toBeFalsy()
    }
  })

  it('三个 number 键按 1–65535 整数校验：0 / 负数 / 小数 / 超上限均被拒', () => {
    for (const k of ['INVITE_REWARD_CREDITS', 'INVITE_REWARD_MAX_INVITEES', 'SIGNUP_BONUS_CREDITS']) {
      expect(writeSettings(store, { [k]: '5' }, { danger: false }).ok, `${k}=5 应被接受`).toBe(true)
      expect(writeSettings(store, { [k]: '0' }, { danger: false }).ok, `${k}=0 应被拒`).toBe(false)
      expect(writeSettings(store, { [k]: '-1' }, { danger: false }).ok, `${k}=-1 应被拒`).toBe(false)
      expect(writeSettings(store, { [k]: '2.5' }, { danger: false }).ok, `${k}=2.5 应被拒`).toBe(false)
      expect(writeSettings(store, { [k]: '65536' }, { danger: false }).ok, `${k}=65536 应被拒`).toBe(false)
    }
  })

  it('邀请开关接受 true/false/1/0，拒绝其他值', () => {
    for (const v of ['true', 'false', '1', '0']) {
      expect(writeSettings(store, { INVITE_REWARD_ENABLED: v }, { danger: false }).ok, `${v} 应被接受`).toBe(true)
    }
    expect(writeSettings(store, { INVITE_REWARD_ENABLED: 'yes' }, { danger: false }).ok).toBe(false)
  })

  it('四个键走普通入口即可保存（不需要危险区二次确认）', () => {
    const r = writeSettings(
      store,
      { INVITE_REWARD_ENABLED: 'true', INVITE_REWARD_CREDITS: '7', INVITE_REWARD_MAX_INVITEES: '9', SIGNUP_BONUS_CREDITS: '5' },
      { danger: false }
    )
    expect(r.ok).toBe(true)
    expect(store.getSetting('INVITE_REWARD_CREDITS')).toBe('7')
  })
})

describe('写入校验', () => {
  it('空 updates 被拒', () => {
    const r = writeSettings(store, {}, { danger: false })
    expect(r.ok).toBe(false)
  })

  it('未知键被拒', () => {
    const r = writeSettings(store, { NOT_A_KEY: '1' }, { danger: false })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('NOT_A_KEY')
  })

  it('只读键被拒，且错误文案说明原因', () => {
    const r = writeSettings(store, { MOTIF_DATA_DIR: '/elsewhere' }, { danger: false })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/环境变量/)
    expect(store.getSetting('MOTIF_DATA_DIR')).toBeNull()
  })

  it('危险区键混进普通保存被拒（不管有没有带确认）', () => {
    const r = writeSettings(store, { MOTIF_EXPOSE_DEV_CODE: 'true' }, { danger: false })
    expect(r.ok).toBe(false)
    expect(store.getSetting('MOTIF_EXPOSE_DEV_CODE')).toBeNull()
  })

  it('普通键混进危险区保存被拒（反向也要挡，否则危险区入口成了万能入口）', () => {
    const r = writeSettings(store, { IMAGE_MODEL: 'x' }, { danger: true })
    expect(r.ok).toBe(false)
  })

  it('URL 必须是 http(s)', () => {
    expect(writeSettings(store, { IMAGE_API_BASE_URL: 'not-a-url' }, { danger: false }).ok).toBe(false)
    expect(writeSettings(store, { IMAGE_API_BASE_URL: 'ftp://gw.example' }, { danger: false }).ok).toBe(false)
    expect(writeSettings(store, { IMAGE_API_BASE_URL: 'https://gw.example/v1' }, { danger: false }).ok).toBe(true)
  })

  it('必填键不允许清空', () => {
    store.setSetting('IMAGE_API_KEY', 'sk-x')
    const r = writeSettings(store, { IMAGE_API_KEY: '' }, { danger: false })
    expect(r.ok).toBe(false)
    expect(store.getSetting('IMAGE_API_KEY')).toBe('sk-x') // 原值未被破坏
  })

  it('可选键清空 = 删除该行（不是写入空串），env 回退随即恢复', () => {
    store.setSetting('MAIL_FROM', 'a@b.co')
    expect(writeSettings(store, { MAIL_FROM: '' }, { danger: false }).ok).toBe(true)
    // 必须删行：写空串会让 resolveSetting 永远返回 ''，把 env 回退永久遮蔽
    expect(store.getSetting('MAIL_FROM')).toBeNull()
    const view = readSettingsView(store, { MAIL_FROM: 'env@b.co' }).find((v) => v.key === 'MAIL_FROM')!
    expect(view.source).toBe('env')
    expect(view.value).toBe('env@b.co')
    expect(view.isSet).toBe(true)
  })

  it('可选键清空且 env 也没有时回到 unset，value / isSet / source 三者自洽', () => {
    store.setSetting('MAIL_FROM', 'a@b.co')
    writeSettings(store, { MAIL_FROM: '' }, { danger: false })
    const view = readSettingsView(store, {}).find((v) => v.key === 'MAIL_FROM')!
    expect(view.source).toBe('unset')
    expect(view.value).toBeNull()
    expect(view.isSet).toBe(false)
  })

  it('非字符串的值被拒而不是抛异常（JSON 里很容易把端口传成数字）', () => {
    const r = writeSettings(store, { SMTP_PORT: 465 as unknown as string }, { danger: false })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('SMTP_PORT')
    expect(store.getSetting('SMTP_PORT')).toBeNull()
  })

  it('枚举只接受白名单值', () => {
    expect(writeSettings(store, { MOTIF_MAILER: 'carrier-pigeon' }, { danger: false }).ok).toBe(false)
    expect(writeSettings(store, { MOTIF_MAILER: 'smtp' }, { danger: false }).ok).toBe(true)
  })

  it('端口必须是 1–65535 的整数', () => {
    expect(writeSettings(store, { SMTP_PORT: '0' }, { danger: false }).ok).toBe(false)
    expect(writeSettings(store, { SMTP_PORT: '465.5' }, { danger: false }).ok).toBe(false)
    expect(writeSettings(store, { SMTP_PORT: '70000' }, { danger: false }).ok).toBe(false)
    expect(writeSettings(store, { SMTP_PORT: '465' }, { danger: false }).ok).toBe(true)
  })

  it('一个键非法时整批不落库（先全量校验再写）', () => {
    const r = writeSettings(store, { IMAGE_MODEL: 'gpt-image-3', IMAGE_API_BASE_URL: 'nope' }, { danger: false })
    expect(r.ok).toBe(false)
    expect(store.getSetting('IMAGE_MODEL')).toBeNull() // 合法的那个也不该写进去
  })

  it('成功时返回写入的键与是否影响运行时', () => {
    const r = writeSettings(store, { IMAGE_MODEL: 'gpt-image-3' }, { danger: false })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.updated).toEqual(['IMAGE_MODEL'])
      expect(r.runtimeAffected).toBe(true)
    }
  })

  it('清空一个影响运行时的键也算影响运行时（删除同样是配置变更）', () => {
    store.setSetting('IMAGE_MODEL', 'gpt-image-3')
    const r = writeSettings(store, { IMAGE_MODEL: '' }, { danger: false })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.runtimeAffected).toBe(true)
  })

  it('写危险区键时 runtimeAffected 为 false（它们每次调用现读，不需要重建运行时）', () => {
    const r = writeSettings(store, { PAYMENT_CHANNEL: 'epay' }, { danger: true })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.runtimeAffected).toBe(false)
  })
})

describe('配置健康检查', () => {
  it('生图配置不全时报告未就绪并给出原因', () => {
    const health = configHealth(store, {})
    const gen = health.find((h) => h.group === 'generation')!
    expect(gen.ready).toBe(false)
    expect(gen.reason).toContain('IMAGE_API_BASE_URL')
  })

  it('配置齐全时报告就绪（正对照）', () => {
    const health = configHealth(store, { IMAGE_API_BASE_URL: 'https://gw.example/v1', IMAGE_API_KEY: 'sk-x' })
    expect(health.find((h) => h.group === 'generation')!.ready).toBe(true)
  })

  it('邮件默认 console 渠道天然就绪', () => {
    expect(configHealth(store, {}).find((h) => h.group === 'mailer')!.ready).toBe(true)
  })

  it('选了 smtp 但缺字段时报告未就绪', () => {
    store.setSetting('MOTIF_MAILER', 'smtp')
    const m = configHealth(store, {}).find((h) => h.group === 'mailer')!
    expect(m.ready).toBe(false)
    expect(m.reason).toContain('SMTP_HOST')
  })

  it('payment 渠道 mock 天然就绪；选了 epay 缺配置时报告未就绪', () => {
    expect(configHealth(store, { PAYMENT_CHANNEL: 'mock' }).find((h) => h.group === 'payment')!.ready).toBe(true)
    const p = configHealth(store, { PAYMENT_CHANNEL: 'epay' }).find((h) => h.group === 'payment')!
    expect(p.ready).toBe(false)
    expect(p.reason).toContain('缺少 EPAY_API_URL')
  })
})

describe('payment 注册表', () => {
  it('money 类型：接受 ≤99999.99 的两位小数，拒绝负数/三位小数/超上限/非数字', () => {
    expect(writeSettings(store, { PRICE_CREDITS_50: '68.00' }, { danger: false })).toMatchObject({ ok: true })
    expect(writeSettings(store, { PRICE_CREDITS_50: '99999.99' }, { danger: false })).toMatchObject({ ok: true })
    expect(writeSettings(store, { PRICE_CREDITS_50: '-1' }, { danger: false })).toMatchObject({ ok: false })
    expect(writeSettings(store, { PRICE_CREDITS_50: '1.234' }, { danger: false })).toMatchObject({ ok: false })
    expect(writeSettings(store, { PRICE_CREDITS_50: '100000' }, { danger: false })).toMatchObject({ ok: false })
    expect(writeSettings(store, { PRICE_CREDITS_50: 'abc' }, { danger: false })).toMatchObject({ ok: false })
  })

  it('BILLING_CURRENCY 只接受注册币种，且不含零小数货币 jpy', () => {
    expect(writeSettings(store, { BILLING_CURRENCY: 'cny' }, { danger: false })).toMatchObject({ ok: true })
    expect(writeSettings(store, { BILLING_CURRENCY: 'rmb' }, { danger: false })).toMatchObject({ ok: false })
    expect(writeSettings(store, { BILLING_CURRENCY: 'jpy' }, { danger: false })).toMatchObject({ ok: false })
  })

  it('PAYMENT_CHANNEL 是危险区键：普通入口拒收，危险入口接受 mock/epay/stripe', () => {
    expect(writeSettings(store, { PAYMENT_CHANNEL: 'epay' }, { danger: false })).toMatchObject({ ok: false })
    expect(writeSettings(store, { PAYMENT_CHANNEL: 'epay' }, { danger: true })).toMatchObject({ ok: true })
    expect(writeSettings(store, { PAYMENT_CHANNEL: 'paypal' }, { danger: true })).toMatchObject({ ok: false })
  })

  it('旧键 MOTIF_BILLING_MODE 已从注册表移除', () => {
    expect(writeSettings(store, { MOTIF_BILLING_MODE: 'live' }, { danger: true })).toMatchObject({ ok: false })
    expect(SETTING_DEFS.some((d) => d.key === 'MOTIF_BILLING_MODE')).toBe(false)
  })
})
