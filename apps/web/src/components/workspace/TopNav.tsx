'use client'

import Link from 'next/link'
import { useState } from 'react'
import { BrandMark } from '@/components/BrandMark'
import { ThemeToggle } from '@/components/workspace/ThemeToggle'
import type { User } from '@motif/core'
import { roleAtLeast, TOPIC_STATUS_LABEL } from '@motif/core'

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
  const [menuOpen, setMenuOpen] = useState(false)
  // 管理后台入口仅对管理员与超级管理员可见（普通用户看不到任何管理面线索）
  const isAdmin = roleAtLeast(user.role, 'admin')
  return (
    <header className="ws-nav">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <Link href="/" className="lp-brand" onClick={(e) => e.preventDefault()}>
          <BrandMark size={26} />
          Motif
        </Link>
        <button className="ws-btn" onClick={onOpenTasks}>任务</button>
        <button className="ws-btn" onClick={onNewTask}>＋ 新任务</button>
        {/* 任务标题只在 ≥lg 展示：768–1023 的平板竖屏宽度不足以容纳完整操作区，
            标题挤占空间会导致按钮文字折行（顶栏挤压的根因） */}
        <span className="ml-2 hidden min-w-0 truncate text-sm lg:block" style={{ color: 'var(--muted)' }} title={topicTitle}>
          {topicTitle}
        </span>
      </div>
      <div className="hidden items-center gap-2 text-sm xl:flex" style={{ color: 'var(--muted-strong)' }}>
        余额 <b>{user.credits}</b> 张
      </div>
      <div className="flex items-center gap-2">
        <span className="ws-badge xl:hidden" title="剩余额度">{user.credits} 张</span>
        <span className="ws-badge hidden xl:flex">余额 {user.credits} 张</span>
        {/* 完整操作区只在 ≥xl（1280）展示；平板档保留「充值」主操作，其余收进菜单。
            顺序与 <xl 的汉堡菜单保持一致：管理后台 / 主题 / 充值 / 用户名 / 退出 */}
        <div className="hidden items-center gap-2 xl:flex">
          {isAdmin && (
            <Link href="/admin" className="ws-btn" title="进入管理后台">
              管理后台
            </Link>
          )}
          <ThemeToggle />
          {/* ⚠️ 不要给这个按钮加 xl:hidden：≥xl 时平板档那个充值按钮与 ⋯ 菜单都已隐藏，
              这里再藏掉就成了「桌面宽度下没有任何充值入口」——用户既买不了额度，
              也打不开充值弹窗里的 CDK 兑换入口 */}
          <button className="ws-btn ws-btn-primary" onClick={onOpenBilling}>充值</button>
          <button className="ws-btn" onClick={onOpenProfile} title="个人资料">{user.name}</button>
          <button className="ws-btn" onClick={onLogout} title={user.email}>退出</button>
        </div>
        {/* <1280：次要操作收进汉堡菜单；充值为主操作保留在顶栏 */}
        <button className="ws-btn ws-btn-primary hidden md:inline-flex xl:hidden" onClick={onOpenBilling}>充值</button>
        <div className="relative xl:hidden">
          <button className="ws-btn" aria-label="更多操作" aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)}>⋯</button>
          {menuOpen && (
            <div className="ws-nav-menu" onClick={() => setMenuOpen(false)}>
              {isAdmin && <Link href="/admin" className="ws-btn">管理后台</Link>}
              <ThemeToggle />
              <button className="ws-btn md:hidden" onClick={onOpenBilling}>充值</button>
              <button className="ws-btn" onClick={onOpenProfile}>{user.name}</button>
              <button className="ws-btn" onClick={onLogout}>退出</button>
            </div>
          )}
        </div>
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
