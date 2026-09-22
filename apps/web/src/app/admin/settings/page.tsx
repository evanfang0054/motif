'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button, Checkbox, Input, Label, Select, ListBox, Switch, Tabs, TextField } from '@heroui/react'
import { CircleCheck, CircleExclamation } from '@gravity-ui/icons'
import { api, type AdminConfigHealth, type AdminSettingItem } from '@/lib/client'
import { GuideCardSection } from '@/components/admin/GuideCardSection'
import { PromptSourcePanel } from '@/components/admin/PromptSourcePanel'
import { useConfirm } from '@/components/admin/confirm'
import { MAILER_GUIDES, PAYMENT_GUIDES } from '@/lib/guide-cards'
import { mailerFieldVisible, paymentFieldVisible, storageFieldVisible } from '@/lib/setting-visibility'
import { enumOptionItems, pickUpdates } from '@/lib/settings-draft'

const GROUP_TITLE: Record<AdminSettingItem['group'], string> = {
  generation: '生图网关',
  credits: '额度与奖励',
  payment: '支付与套餐',
  mailer: '邮件发信',
  llm: '提示词增强',
  storage: '图片存储',
  // 该分区**没有任何配置键**，只承载「提示词源状态 + 立即刷新」这个动作型面板
  prompts: '提示词库',
  security: '会话与安全',
  danger: '危险区',
  data: '数据位置（只读）',
}

const GROUP_ORDER: AdminSettingItem['group'][] = ['generation', 'credits', 'payment', 'mailer', 'llm', 'storage', 'prompts', 'security', 'data']

const HEALTH_LABEL: Record<string, string> = {
  generation: '生图网关',
  payment: '支付渠道',
  mailer: '邮件发信',
  llm: '提示词增强',
  storage: '图片存储',
}

export default function AdminSettingsPage() {
  const [items, setItems] = useState<AdminSettingItem[]>([])
  const [health, setHealth] = useState<AdminConfigHealth[]>([])
  const [dirty, setDirty] = useState<Record<string, string>>({})
  const [confirmed, setConfirmed] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testTo, setTestTo] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)
  const { confirm, confirmElement } = useConfirm()
  const [tab, setTab] = useState<string>('generation')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api.adminGetSettings()
      setItems(r.items)
      setHealth(r.health)
      setDirty({})
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const setField = (key: string, value: string) => setDirty((d) => ({ ...d, [key]: value }))

  async function save(group: AdminSettingItem['group']) {
    const updates = pickUpdates({ items, dirty, group })
    if (Object.keys(updates).length === 0) {
      setMsg('没有改动需要保存。')
      setErr(null)
      return
    }
    setSaving(true)
    setErr(null)
    setMsg(null)
    try {
      if (group === 'danger') {
        if (!(await confirm({ message: '危险区开关会削弱系统安全基线，确定要应用吗？', confirmLabel: '应用' }))) return
        await api.adminSaveDangerSettings(updates)
      } else {
        await api.adminSaveSettings(updates)
      }
      setMsg('已保存；新配置已对后续生成生效。')
      window.scrollTo({ top: 0, behavior: 'smooth' }) // 危险区在长页底部，滚回顶部让结果提示可见
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  function field(item: AdminSettingItem) {
    if (item.readOnly) {
      // 未设置时给出「实际会落在哪」的提示：只读项常常是空的（默认路径由应用自己拼），
      // 只显示空输入框会让运维以为没配置、不知道数据在哪
      return (
        <TextField isDisabled value={item.value ?? ''} aria-label={item.label}>
          <Input placeholder={item.defaultHint ? `未设置，默认 ${item.defaultHint}` : '未设置'} />
        </TextField>
      )
    }
    if (item.kind === 'enum') {
      const current = dirty[item.key] ?? item.value ?? ''
      return (
        <Select
          aria-label={item.label}
          value={current || null}
          onChange={(v) => setField(item.key, (v as string) ?? '')}
        >
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              {enumOptionItems(item.options).map((o) => (
                <ListBox.Item key={`${item.key}-${o.id}`} id={o.id} textValue={o.label}>
                  {o.label}
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
      )
    }
    if (item.kind === 'boolean') {
      return (
        <Switch
          isSelected={(dirty[item.key] ?? item.value ?? 'false') === 'true'}
          onChange={(sel) => setField(item.key, sel ? 'true' : 'false')}
          aria-label={item.label}
        >
          <Switch.Content>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
          </Switch.Content>
        </Switch>
      )
    }
    if (item.kind === 'secret') {
      return (
        <TextField
          type="password"
          autoComplete="new-password"
          value={dirty[item.key] ?? ''}
          onChange={(v) => setField(item.key, v)}
        >
          <Input placeholder={item.isSet ? `已设置（${item.masked}），留空则不修改` : '未设置'} />
        </TextField>
      )
    }
    return (
      <TextField
        value={dirty[item.key] ?? item.value ?? ''}
        onChange={(v) => setField(item.key, v)}
      >
        <Input placeholder={item.defaultHint ? `默认 ${item.defaultHint}` : ''} />
      </TextField>
    )
  }

  /**
   * 分区的「配置就绪」提示行。
   *
   * 为什么需要它：`llm` 与 `storage` 都是**开了开关但配置不全就静默降级**的能力 ——
   * 增强失败会降级为原文、存储写不进去只在服务端报错。若页面上不给就绪判据，运维只会看到
   * 「功能没生效」而找不到原因（判据其实早就在接口里，只是没人渲染）。
   */
  function healthLine(group: string) {
    const h = health.find((x) => x.group === group)
    if (!h) return null
    return (
      <p className="admin-field-hint" data-slot="config-health">
        {HEALTH_LABEL[group] ?? group}配置：
        {h.ready ? (
          <>
            <CircleCheck className="me-1 inline align-[-0.125em]" aria-hidden />
            已就绪
          </>
        ) : (
          <>
            <CircleExclamation className="me-1 inline align-[-0.125em]" aria-hidden />
            未就绪：{h.reason ?? '配置不完整'}
          </>
        )}
      </p>
    )
  }

  /** 渲染一个分区的表单体（外层的分区切换由 Tabs 承担，见组件根部） */
  function renderGroupBody(group: AdminSettingItem['group']) {
    const groupItems = items.filter((i) => i.group === group)
    // 提示词库分区没有配置键，若跟着空组一起早退，面板就整块渲染不出来
    if (groupItems.length === 0 && group !== 'prompts') return null
    if (group === 'prompts') return <PromptSourcePanel />
    // 显隐按「草稿优先」裁决：未保存的渠道选择立即生效于字段展示，
    // 否则 mock/console 渠道下凭据字段不渲染，「先填凭据→保存」的接入路径走不通
    const selectorKey = group === 'mailer' ? 'MOTIF_MAILER' : group === 'payment' ? 'PAYMENT_CHANNEL' : 'STORAGE_DRIVER'
    const savedChannel = items.find((i) => i.key === selectorKey)?.value ?? null
    const dirtyKey = dirty[selectorKey]
    const draftChannel = dirtyKey ?? savedChannel
    const visibleOf =
      group === 'mailer'
        ? (key: string) => mailerFieldVisible({ key }, draftChannel)
        : group === 'payment'
          ? (key: string) => paymentFieldVisible({ key }, draftChannel)
          : group === 'storage'
            ? (key: string) => storageFieldVisible({ key }, draftChannel)
            : null
    const shownItems = visibleOf ? groupItems.filter((i) => visibleOf(i.key)) : groupItems
    const channelDirty = !!dirtyKey && dirtyKey !== savedChannel
    const guideCards =
      group === 'mailer'
        ? (MAILER_GUIDES[(draftChannel ?? 'console') as keyof typeof MAILER_GUIDES] ?? [])
        : group === 'payment'
          ? (PAYMENT_GUIDES[(draftChannel ?? 'mock') as 'epay' | 'stripe'] ?? [])
          : []
    return (
      <>
        {group === 'data' && (
          <p className="admin-muted">
            这两项决定数据库自身的位置，属于先于数据库存在的引导参数，只能在部署的环境变量里修改。
          </p>
        )}
        {guideCards.length > 0 && <GuideCardSection cards={guideCards} />}
        {/* 只有「开关型 + 静默降级」的两个分区需要就绪行（payment 的就绪提示在危险区 PAYMENT_CHANNEL 旁） */}
        {(group === 'llm' || group === 'storage') && healthLine(group)}
        {channelDirty && (
          <p className="admin-field-hint">
            渠道已改为「{dirtyKey}」尚未保存：下方字段与引导卡已按新渠道显示，填好后点「保存」生效。
          </p>
        )}
        {shownItems.map((item) => (
          <div className="admin-field" key={item.key}>
            <label htmlFor={`setting-${item.key}`}>
              {item.label}
              <span className="admin-field-key">
                {item.key}
                {item.readOnly && <span className="admin-badge-readonly">只读</span>}
                {item.source === 'env' && <span className="admin-badge-readonly">来自环境变量</span>}
              </span>
            </label>
            {field(item)}
            {item.hint && <p className="admin-field-hint">{item.hint}</p>}
          </div>
        ))}
        {group !== 'data' && groupItems.length > 0 && (
          <Button variant="secondary" isDisabled={saving} onPress={() => void save(group)}>
            保存
          </Button>
        )}
        {group === 'mailer' && (
          <div className="admin-field">
            <TextField aria-label="测试收件邮箱" value={testTo} onChange={setTestTo}>
              <Label>发送测试邮件到（需超级管理员）</Label>
              <Input placeholder="you@example.com" />
            </TextField>
            <Button
              variant="secondary"
              aria-busy={testing}
              isDisabled={testing || !testTo.trim()}
              onPress={async () => {
                setTesting(true)
                setTestResult(null)
                try {
                  const r = await api.adminTestMail(testTo.trim())
                  setTestResult(
                    r.via === 'console'
                      ? { ok: true, text: '当前是 console 渠道：不会真实发信，测试内容已打印到服务端日志。' }
                      : { ok: true, text: `测试邮件已通过 ${r.via} 渠道发出，请查收。` }
                  )
                } catch (e) {
                  setTestResult({ ok: false, text: e instanceof Error ? e.message : '发送失败' })
                } finally {
                  setTesting(false)
                }
              }}
            >
              {testing ? '发送中…' : '发送测试邮件'}
            </Button>
            <p className="admin-field-hint">先点上方「保存」再测试；失败原因（如 SMTP 535 授权码错误）会原样显示在这里。</p>
            {testResult && (
              <div className={testResult.ok ? 'admin-alert-ok' : 'admin-alert-err'} role="status">
                {testResult.text}
              </div>
            )}
          </div>
        )}
      </>
    )
  }

  const dangerItems = items.filter((i) => i.group === 'danger')

  return (
    <section className="admin-panel" id="settings-root">
      <h1 className="admin-title">系统设置</h1>
      <p className="admin-muted">配置以数据库为准：环境变量仅首次播种，此后一律在这里改。</p>

      {loading && <p className="admin-muted">加载中…</p>}
      {err && (
        <div className="admin-alert-err" role="alert">
          {err}
        </div>
      )}
      {msg && <div className="admin-alert-ok">{msg}</div>}

      {items.length > 0 && (
        <Tabs selectedKey={tab} onSelectionChange={(k) => setTab(String(k))}>
          <Tabs.ListContainer>
            <Tabs.List aria-label="系统设置分区">
              {GROUP_ORDER.map((g) => (
                <Tabs.Tab key={g} id={g}>
                  {GROUP_TITLE[g]}
                  <Tabs.Indicator />
                </Tabs.Tab>
              ))}
              {dangerItems.length > 0 && (
                <Tabs.Tab id="danger">
                  {GROUP_TITLE.danger}
                  <Tabs.Indicator />
                </Tabs.Tab>
              )}
            </Tabs.List>
          </Tabs.ListContainer>
          {GROUP_ORDER.map((g) => (
            <Tabs.Panel key={g} id={g}>
              {renderGroupBody(g)}
            </Tabs.Panel>
          ))}
          {dangerItems.length > 0 && (
            <Tabs.Panel id="danger">
              <p className="admin-muted">以下开关会削弱系统安全基线，变更需二次确认并留痕。</p>
              {dangerItems.map((item) => (
                <div className="admin-field" key={item.key}>
                  <label htmlFor={`setting-${item.key}`}>
                    {item.label}
                    <span className="admin-field-key">{item.key}</span>
                  </label>
                  {field(item)}
                  {item.hint && <p className="admin-field-hint">{item.hint}</p>}
                  {item.key === 'PAYMENT_CHANNEL' && (() => {
                    const paymentHealth = health.find((h) => h.group === 'payment')
                    return (
                      <p className="admin-field-hint">
                        当前支付配置：
                        {paymentHealth?.ready ? (
                          <>
                            <CircleCheck className="me-1 inline align-[-0.125em]" aria-hidden />
                            已就绪
                          </>
                        ) : (
                          <>
                            <CircleExclamation className="me-1 inline align-[-0.125em]" aria-hidden />
                            未就绪：{paymentHealth?.reason ?? '配置不完整'}
                          </>
                        )}
                        <button
                          type="button"
                          onClick={() => setTab('payment')}
                          style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}
                        >
                          前往「支付与套餐」
                        </button>
                      </p>
                    )
                  })()}
                </div>
              ))}
              {/* 未选中态必须有可见边框（WCAG 2.1 SC 1.4.11 要求控件边界对相邻背景 ≥3:1）。
                  边框色用 --muted 而非 --border / --border-strong：后两者是发丝线级别的弱令牌，
                  实测对面板底仅 1.14:1（亮）/ 1.35:1（暗）与 1.57:1 / 1.75:1，均不达标；
                  --muted 实测 5.13:1（亮）/ 6.16:1（暗），是当前调色板里唯一过线且不过重的选择。
                  走 Checkbox.Control 的 className 是官方定制面（见 demos/cn/checkbox/custom-styles.tsx），
                  不是覆盖组件内部样式。
                  ⚠️ 必须只在**未选中**态生效：HeroUI 组件样式在 layer(components)、Tailwind 工具类
                  在 layer(utilities)，后者层序在后 —— 无条件加边框会盖掉组件自己的状态边框，
                  导致选中态在珊瑚方块外多出一圈灰环。故用 group + data-[selected=true] 把它让回去。 */}
              <Checkbox
                className="group my-3"
                isSelected={confirmed}
                onChange={(sel) => setConfirmed(sel)}
              >
                <Checkbox.Content>
                  <Checkbox.Control className="border border-solid border-[var(--muted)] group-data-[selected=true]:border-transparent">
                    <Checkbox.Indicator />
                  </Checkbox.Control>
                  <Label>我已了解上述后果</Label>
                </Checkbox.Content>
              </Checkbox>
              {/* 危险按钮沿用后台既有的 .admin-btn-danger 描边样式（红字红边），
                  文字色走 --danger-quiet（暗色 #eb6962）保证 AA。 */}
              <button className="admin-btn-danger" disabled={!confirmed || saving} onClick={() => void save('danger')}>
                应用危险区开关
              </button>
            </Tabs.Panel>
          )}
        </Tabs>
      )}

      {confirmElement}
    </section>
  )
}
