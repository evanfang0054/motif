'use client'

import Link from 'next/link'
import { BrandMark } from '@/components/BrandMark'
import { ThemeToggle } from '@/components/workspace/ThemeToggle'
import type { User } from '@motif/core'
import { TOPIC_STATUS_LABEL } from '@motif/core'

interface Props {
  user: User
  topicTitle: string
  status?: string
  onOpenTasks: () => void
  onNewTask: () => void
  onOpenBilling: () => void
  onOpenProfile: () => void
  onLogout: () => void
}

function TopNav({ user, topicTitle, onOpenTasks, onNewTask, onOpenBilling, onOpenProfile, onLogout }: Props) {
  return (
    <header className="ws-nav">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <Link href="/" className="lp-brand" onClick={(e) => e.preventDefault()}>
          <BrandMark size={26} />
          motif
        </Link>
        <button className="ws-btn" onClick={onOpenTasks}>任务</button>
        <button className="ws-btn" onClick={onNewTask}>＋ 新任务</button>
        <span className="ml-2 hidden min-w-0 truncate text-sm md:block" style={{ color: 'var(--muted)' }} title={topicTitle}>
          {topicTitle}
        </span>
      </div>
      <div className="hidden items-center gap-2 text-sm lg:flex" style={{ color: 'var(--muted-strong)' }}>
        余额 <b>{user.credits}</b> 张
      </div>
      <div className="flex items-center gap-2">
        <span className="ws-badge lg:hidden">余额 {user.credits} 张</span>
        <ThemeToggle />
        <button className="ws-btn ws-btn-primary" onClick={onOpenBilling}>充值</button>
        <button className="ws-btn" onClick={onOpenProfile} title="个人资料">{user.name}</button>
        <button className="ws-btn" onClick={onLogout} title={user.email}>退出</button>
      </div>
    </header>
  )
}

export { TopNav }

// 供面板复用的状态徽标
function StatusBadge({ status }: { status: string }) {
  const label = TOPIC_STATUS_LABEL[status as keyof typeof TOPIC_STATUS_LABEL] ?? status
  const color =
    ({
      running: 'var(--status-running)',
      pending: 'var(--status-pending)',
      canceling: 'var(--status-canceling)',
      failed: 'var(--status-failed)',
      canceled: 'var(--status-canceled)',
      completed: 'var(--status-completed)',
    } as Record<string, string>)[status] ?? 'var(--status-idle)'
  return (
    <span className="ws-badge">
      <span className="ws-status-dot" style={{ background: color }} />
      {label}
    </span>
  )
}

export { StatusBadge }
