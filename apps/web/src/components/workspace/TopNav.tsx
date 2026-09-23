'use client'

import { useState } from 'react'
import { Avatar, Button, Popover, Tooltip, Typography } from '@heroui/react'
import { InlineText } from '@/components/ui/typography'
import { ChevronDown, Palette, Person, Power, Shield, Wallet } from '@gravity-ui/icons'
import { anchorRender } from '@/components/ui/anchor-button'
import { BrandMark } from '@/components/BrandMark'
import { ThemeToggle } from '@/components/workspace/ThemeToggle'
import type { User } from '@motif/core'
import { roleAtLeast } from '@motif/core'

interface Props {
  user: User
  onOpenBilling: () => void
  onOpenProfile: () => void
  onLogout: () => void
}

/**
 * 导航头。
 *
 * 2026-09-21 用户裁决：**导航头保持不变**（仍是占位式顶栏，横贯全宽、画布从它下面开始）——
 * 浮在画布上的是**两侧面板**，不是顶栏。所以这里没有「收起/展开面板」按钮：
 * 开关两侧面板的入口都在画布上的浮动面板 / 浮动条里，见 Workspace。
 *
 * ⚠️ 上一轮曾把本组件拆成「左上 / 右上两条浮动条」并在这里塞了一个「任务面板」切换按钮，
 * 那是**对第 4 条的误读**（把「左上有个浮动条」理解成了顶栏要浮动）。已按用户澄清改回。
 *
 * 2026-09-21 二次裁决：左侧那两个元素（「＋新任务」按钮、当前任务名）**从顶栏移除** ——
 * 它们已经（新建）或应当（任务名）待在左侧面板与左上浮动条里，顶栏重复一份等于同一件事有两个入口。
 * 顶栏现在只负责「我是谁 / 我还有多少额度 / 去哪充值」这三件事。
 *
 * 顶栏右侧的收口口径沿用 2026-09-21 的裁决：次要动作收进**会员头像 + 下拉**
 * （个人资料 / 管理后台 / 主题外观 / 退出），**充值与余额留在外面** ——
 * 充值是主操作，也是「额度不足」时唯一的出路，藏进下拉等于每次都要多绕一步。
 *
 * 2026-09-21 三次裁决：
 * ① 「余额 N 张」徽标与「充值」按钮**合并成一个入口**（钱包图标 + 张数，点击开充值弹窗）。
 *    此前两者并排，读的是「还有多少」、点的是「去买」两件事挤在一起；合并后一个控件同时表达
 *    「余额是这个数」与「点它去充值」。⚠️ 合并后**必须常驻**（不再有 `hidden md:*`）——
 *    它现在是唯一的充值入口，任何断点下消失都等于买不了额度、也打不开弹窗里的 CDK 兑换。
 * ② 下拉里的行改成 **ghost 变体**：那些浅灰底是 HeroUI `secondary` 自带的面板色，
 *    在白色弹层里叠出一层灰，看着像「弹层里又嵌了卡片」。ghost 无底色、hover 才浮起，
 *    才是菜单该有的样子。
 * ③ 下拉改为**菜单式内边距**（外框 6px、行铺满），行与行不再靠底色区分、改由分隔线分组。
 */
function TopNav({ user, onOpenBilling, onOpenProfile, onLogout }: Props) {
  // 管理后台入口仅对管理员与超级管理员可见（普通用户看不到任何管理面线索）
  const isAdmin = roleAtLeast(user.role, 'admin')
  const [menuOpen, setMenuOpen] = useState(false)
  const closeMenu = () => setMenuOpen(false)
  /** 头像回退：昵称首字符；昵称为空时退到通用人像图标 */
  const initial = user.name.trim().charAt(0)

  return (
    <header className="ws-nav">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {/* 品牌标识（不可点）：已登录时 `/` 渲染的就是工作台本身，做成链接等于整页刷新，
            故与落地页页脚的品牌同构，只做展示 */}
        <InlineText type="body" className="lp-brand shrink-0">
          <BrandMark size={26} />
          Motif
        </InlineText>
      </div>

      <div className="flex items-center gap-2">
        {/* 余额 + 充值合并入口：钱包图标 + 张数，点击直接开充值弹窗。
            没有「充值」字样是刻意的（用户裁决：更短）；含义由 Tooltip / aria-label 补上，
            视觉用户 hover 得到提示，读屏用户拿到完整动作名。
            ⚠️ Tooltip 必须**直接包住** Button（同 IconButton 的说明：TooltipTrigger 靠 clone
            直接子元素注入 aria-describedby），写成 `<Tooltip.Trigger><Button/></Tooltip.Trigger>`
            会多套一层 `div[role=button]`。 */}
        <Tooltip delay={0}>
          <Button
            variant="primary"
            className="shrink-0"
            aria-label={`余额 ${user.credits} 张，点击充值`}
            onPress={onOpenBilling}
          >
            <Wallet />
            {user.credits} 张
          </Button>
          <Tooltip.Content>充值 / 兑换</Tooltip.Content>
        </Tooltip>
        <div className="relative">
          <Popover isOpen={menuOpen} onOpenChange={setMenuOpen}>
            {/* Popover.Trigger 渲染的是真实 DOM 包装（Pressable > div[role=button]，popover.js 实证），
                不像 Dropdown/Modal 那样 clone 子元素 → 复杂触发件（头像 + 文字 + 箭头）可以安全放进来 */}
            <Popover.Trigger>
              <Button variant="secondary" aria-label="账号菜单" className="max-w-[160px]">
                <Avatar size="sm">
                  {user.avatarUrl ? <Avatar.Image src={user.avatarUrl} alt={user.name} /> : null}
                  <Avatar.Fallback delayMs={0}>{initial || <Person />}</Avatar.Fallback>
                </Avatar>
                <span className="hidden max-w-[9ch] truncate sm:inline">{user.name}</span>
                <ChevronDown />
              </Button>
            </Popover.Trigger>
            <Popover.Content>
              {/* 下拉里一律「图标 + 文字」而不是图标 + Tooltip：hover 才显字在菜单里既反直觉，
                  也与顶栏那些真正的图标按钮撞手感。
                  ⚠️ 布局是一条**统一左轨**：面板内边距 6px + 每块内容自己的 10px = 16px，
                  身份块 / 每个行 / 「外观」行**全部**落在这一条线上。
                  改之前是四块各自一个起点（身份块 16px、行图标 22px、「外观」标签 16px、
                  「退出」文字 22px），看着像四段拼起来的 —— 这是 2026-09-21 走查截图放大后
                  才看清的问题（坐标探针只看得到尺寸、看不到「对不对齐」）。
                  行高也统一 h-8：之前「外观」行是 py-2 撑出来的 45px，比其它行高 13px。
                  行是 ghost（无底色），行与行之间不再留 gap —— 菜单的视觉分组交给分隔线。
                  ⚠️ 三个 ghost 行用 `pl-3 pr-2.5` 而非 `px-2.5`：HeroUI 的 Button 给第一个图标
                  子元素挂了 `margin-left: -2px`（实测 computed style），照 10px 内边距算图标会落在
                  14px，而身份块文字与「外观」图标在 16px。左侧补回 2px 后三者同为 16px。 */}
              <div className="flex w-[232px] flex-col p-1.5">
                {/* 账号身份只做展示（不可点）：邮箱是「我是谁」的判据 */}
                <div className="min-w-0 px-2.5 pt-1.5 pb-2">
                  <div className="truncate text-sm font-semibold">{user.name}</div>
                  <div className="truncate text-xs" style={{ color: 'var(--muted)' }}>{user.email}</div>
                </div>
                <div className="my-1.5" style={{ borderTop: '1px solid var(--border)' }} />

                <Button
                  variant="ghost"
                  className="h-8 justify-start pl-3 pr-2.5"
                  onPress={() => {
                    closeMenu()
                    onOpenProfile()
                  }}
                >
                  <Person />个人资料
                </Button>

                {isAdmin && (
                  <Button
                    variant="ghost"
                    className="h-8 justify-start pl-3 pr-2.5"
                    render={anchorRender({ href: '/admin' })}
                    onPress={closeMenu}
                  >
                    <Shield />管理后台
                  </Button>
                )}

                {/* 主题外观：与其它行同高同轨，「外观」标签占满剩余宽度把三段切换顶到右端。
                    gap-1.5(6px) 而不是 gap-2(8px)：HeroUI 按钮内部 icon↔label 的间距就是 6px，
                    用 8px 会让「外观」的文字比「个人资料」右移 2px、文字列断成两段。
                    点任意一段即收起（点击冒泡捕获）。 */}
                <div className="flex h-8 items-center gap-1.5 px-2.5" onClick={closeMenu}>
                  <Palette />
                  <span className="flex-1 text-sm">外观</span>
                  <ThemeToggle />
                </div>

                <div className="my-1.5" style={{ borderTop: '1px solid var(--border)' }} />
                <Button
                  variant="ghost"
                  className="h-8 justify-start pl-3 pr-2.5"
                  onPress={() => {
                    closeMenu()
                    onLogout()
                  }}
                >
                  <Power />退出
                </Button>
              </div>
            </Popover.Content>
          </Popover>
        </div>
      </div>
    </header>
  )
}

export { TopNav }
