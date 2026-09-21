'use client'

import Link from 'next/link'
import { useState } from 'react'
import { Button, Popover } from '@heroui/react'
import { Ellipsis, ListCheck, Plus, Shield } from '@gravity-ui/icons'
import { anchorRender } from '@/components/ui/anchor-button'
import { IconButton } from '@/components/ui/icon-button'
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
  // 管理后台入口仅对管理员与超级管理员可见（普通用户看不到任何管理面线索）
  const isAdmin = roleAtLeast(user.role, 'admin')
  // Popover 不支持 slot="close"（仅 Modal/AlertDialog/Drawer 支持，冒烟实证）→ 受控开合 + 菜单项显式关闭
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    <header className="ws-nav">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <Link href="/" className="lp-brand" onClick={(e) => e.preventDefault()}>
          <BrandMark size={26} />
          Motif
        </Link>
        {/* 图标化口径（2026-09-21 裁决）：次要入口收成图标 + Tooltip；主路径与首次关键操作留文字。
            任务列表 / 新建任务 / 管理后台属次要入口 → 图标；充值（主操作）、用户名、退出留文字。 */}
        <IconButton variant="secondary" label="任务" onPress={onOpenTasks}>
          <ListCheck />
        </IconButton>
        <IconButton variant="secondary" label="新任务" onPress={onNewTask}>
          <Plus />
        </IconButton>
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
            <IconButton variant="secondary" label="管理后台" render={anchorRender({ href: '/admin' })}>
              <Shield />
            </IconButton>
          )}
          <ThemeToggle />
          {/* ⚠️ 不要给这个按钮加 xl:hidden：≥xl 时平板档那个充值按钮与 ⋯ 菜单都已隐藏，
              这里再藏掉就成了「桌面宽度下没有任何充值入口」——用户既买不了额度，
              也打不开充值弹窗里的 CDK 兑换入口 */}
          <Button variant="primary" onPress={onOpenBilling}>充值</Button>
          <Button variant="secondary" onPress={onOpenProfile}>{user.name}</Button>
          <Button variant="secondary" onPress={onLogout}>退出</Button>
        </div>
        {/* <1280：次要操作收进汉堡菜单；充值为主操作保留在顶栏 */}
        <Button variant="primary" className="hidden md:inline-flex xl:hidden" onPress={onOpenBilling}>充值</Button>
        <div className="relative xl:hidden">
          <Popover isOpen={menuOpen} onOpenChange={setMenuOpen}>
            {/* Popover.Trigger 渲染的是真实 DOM 包装（Pressable > div[role=button]，popover.js 实证），
                不像 Dropdown/Modal 那样 clone 子元素 → IconButton 可以安全地放进来，Tooltip 照常工作 */}
            <Popover.Trigger>
              <IconButton variant="secondary" label="更多操作">
                <Ellipsis />
              </IconButton>
            </Popover.Trigger>
            <Popover.Content>
              {/* 菜单内的项一律「图标 + 文字」而不是图标 + Tooltip：菜单项按规范必须带可见标签
                  （HeroUI 的 Dropdown.Item 也强制要 textValue），hover 才显字在菜单里既反直觉
                  又与顶栏那些真正的图标按钮撞手感 */}
              <div className="flex min-w-[160px] flex-col gap-2 p-3">
                {isAdmin && (
                  <Button
                    variant="secondary"
                    className="justify-start"
                    render={anchorRender({ href: '/admin' })}
                    onPress={() => setMenuOpen(false)}
                  >
                    <Shield />管理后台
                  </Button>
                )}
                {/* 原实现点菜单内任意元素即收起：主题切换同样关菜单（点击冒泡捕获） */}
                <div onClick={() => setMenuOpen(false)}>
                  <ThemeToggle />
                </div>
                <Button
                  variant="secondary"
                  className="md:hidden"
                  onPress={() => {
                    setMenuOpen(false)
                    onOpenBilling()
                  }}
                >充值</Button>
                <Button
                  variant="secondary"
                  onPress={() => {
                    setMenuOpen(false)
                    onOpenProfile()
                  }}
                >{user.name}</Button>
                <Button
                  variant="secondary"
                  onPress={() => {
                    setMenuOpen(false)
                    onLogout()
                  }}
                >退出</Button>
              </div>
            </Popover.Content>
          </Popover>
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
