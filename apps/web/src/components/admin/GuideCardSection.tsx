'use client'

import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import type { GuideCard } from '@/lib/guide-cards'

/**
 * 引导卡区块：用 .admin-guide 浅底卡（不用 admin-panel，避免卡中卡双边框双阴影）。
 * QR 以 320px 生成、160px 显示（2x 高分屏可扫）；白底衬垫保证暗色主题下可扫。
 */
export function GuideCardSection({ cards }: { cards: GuideCard[] }) {
  const [open, setOpen] = useState(false)
  const [qr, setQr] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!open) return
    let alive = true
    void Promise.all(cards.map((c) => QRCode.toDataURL(c.linkUrl, { width: 320, margin: 2 }))).then((urls) => {
      if (alive) setQr(Object.fromEntries(cards.map((c, i) => [c.id, urls[i]])))
    })
    return () => {
      alive = false
    }
  }, [open, cards])

  if (cards.length === 0) return null
  return (
    <details className="admin-guide" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>接入引导：如何申请凭据（含手机扫码入口）</summary>
      {cards.map((c) => (
        <div className="admin-field" key={c.id}>
          <b>{c.title}</b>
          <ol>
            {c.steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
          {qr[c.id] && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <span className="admin-qr">
              <img src={qr[c.id]} alt={`${c.linkLabel} 二维码`} width={160} height={160} />
            </span>
          )}
          <a className="admin-guide-link" href={c.linkUrl} target="_blank" rel="noreferrer">
            {c.linkLabel} ↗
          </a>
          {c.note && <p className="admin-field-hint">{c.note}</p>}
        </div>
      ))}
    </details>
  )
}
