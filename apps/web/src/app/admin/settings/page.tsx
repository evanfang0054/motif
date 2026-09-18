'use client'

import { useCallback, useEffect, useState } from 'react'
import { api, type AdminConfigHealth, type AdminSettingItem } from '@/lib/client'

const GROUP_TITLE: Record<AdminSettingItem['group'], string> = {
  generation: '生图网关',
  mailer: '邮件发信',
  security: '会话与安全',
  danger: '危险区',
  data: '数据位置（只读）',
}

const GROUP_ORDER: AdminSettingItem['group'][] = ['generation', 'mailer', 'security', 'data']

const HEALTH_LABEL: Record<string, string> = {
  generation: '生图网关',
  mailer: '邮件发信',
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

  /** 只提交本组里改动过的键 —— 密钥框初值恒为空，未输入就不会进 dirty */
  function pickedFrom(group: AdminSettingItem['group']): Record<string, string> {
    const keys = new Set(items.filter((i) => i.group === group).map((i) => i.key))
    return Object.fromEntries(Object.entries(dirty).filter(([k]) => keys.has(k)))
  }

  async function save(group: AdminSettingItem['group']) {
    const updates = pickedFrom(group)
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
        if (!window.confirm('危险区开关会削弱系统安全基线，确定要应用吗？')) return
        await api.adminSaveDangerSettings(updates)
      } else {
        await api.adminSaveSettings(updates)
      }
      setMsg('已保存；新配置已对后续生成生效。')
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  function field(item: AdminSettingItem) {
    if (item.readOnly) {
      return <input value={item.value ?? ''} readOnly disabled aria-label={item.label} />
    }
    if (item.kind === 'enum') {
      return (
        <select
          value={dirty[item.key] ?? item.value ?? ''}
          onChange={(e) => setField(item.key, e.target.value)}
          aria-label={item.label}
        >
          {(item.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      )
    }
    if (item.kind === 'boolean') {
      return (
        <select
          value={dirty[item.key] ?? item.value ?? 'false'}
          onChange={(e) => setField(item.key, e.target.value)}
          aria-label={item.label}
        >
          <option value="false">关闭</option>
          <option value="true">开启</option>
        </select>
      )
    }
    if (item.kind === 'secret') {
      return (
        <input
          type="password"
          autoComplete="new-password"
          value={dirty[item.key] ?? ''}
          onChange={(e) => setField(item.key, e.target.value)}
          placeholder={item.isSet ? `已设置（${item.masked}），留空则不修改` : '未设置'}
          aria-label={item.label}
        />
      )
    }
    return (
      <input
        value={dirty[item.key] ?? item.value ?? ''}
        onChange={(e) => setField(item.key, e.target.value)}
        placeholder={item.defaultHint ? `默认 ${item.defaultHint}` : ''}
        aria-label={item.label}
      />
    )
  }

  function renderGroup(group: AdminSettingItem['group']) {
    const groupItems = items.filter((i) => i.group === group)
    if (groupItems.length === 0) return null
    return (
      <section className="admin-panel" key={group} id={`settings-${group}`}>
        <h2 className="admin-title">{GROUP_TITLE[group]}</h2>
        {group === 'data' && (
          <p className="admin-muted">
            这两项决定数据库自身的位置，属于先于数据库存在的引导参数，只能在部署的环境变量里修改。
          </p>
        )}
        {groupItems.map((item) => (
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
        {group !== 'data' && (
          <button className="ws-btn" disabled={saving} onClick={() => void save(group)}>
            保存
          </button>
        )}
      </section>
    )
  }

  const dangerItems = items.filter((i) => i.group === 'danger')

  return (
    <section className="admin-panel" id="settings-root">
      <h1 className="admin-title">系统设置</h1>
      <p className="admin-muted">
        配置的真相在这张数据库表里：首次启动会把环境变量播种进来，此后一律以这里为准。
      </p>

      {loading && <p className="admin-muted">加载中…</p>}
      {err && (
        <div className="admin-alert-err" role="alert">
          {err}
        </div>
      )}
      {msg && <div className="admin-alert-ok">{msg}</div>}

      <div className="admin-health" id="settings-health">
        {health.map((h) => (
          <div className="admin-health-item" key={h.group}>
            {h.ready ? '✅' : '⚠️'} {HEALTH_LABEL[h.group] ?? h.group}
            {h.ready ? '已就绪' : `未就绪：${h.reason ?? '配置不完整'}`}
          </div>
        ))}
      </div>

      {GROUP_ORDER.map((g) => renderGroup(g))}

      {dangerItems.length > 0 && (
        <section className="admin-panel admin-danger" id="settings-danger">
          <h2 className="admin-title">{GROUP_TITLE.danger}</h2>
          <p className="admin-muted">以下开关会削弱系统安全基线，变更需二次确认并留痕。</p>
          {dangerItems.map((item) => (
            <div className="admin-field" key={item.key}>
              <label htmlFor={`setting-${item.key}`}>
                {item.label}
                <span className="admin-field-key">{item.key}</span>
              </label>
              {field(item)}
              {item.hint && <p className="admin-field-hint">{item.hint}</p>}
            </div>
          ))}
          <label className="admin-confirm-line">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            我已了解上述后果
          </label>
          <button className="ws-btn admin-danger-btn" disabled={!confirmed || saving} onClick={() => void save('danger')}>
            应用危险区开关
          </button>
        </section>
      )}
    </section>
  )
}
