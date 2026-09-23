'use client'

import { useState } from 'react'
import { Button, Input, TextField, Typography } from '@heroui/react'
import { ChevronLeft, Pencil, Plus, TrashBin } from '@gravity-ui/icons'
import { IconButton } from '@/components/ui/icon-button'
import { InlineText } from '@/components/ui/typography'
import { usePublicConfig } from '@/lib/use-public-config'
import type { Topic } from '@motif/core'
import { TOPIC_STATUS_LABEL, validateTopicTitle } from '@motif/core'

interface Props {
  topics: Topic[]
  activeId: string | null
  /** 当前任务名：面板头的标题。2026-09-21 裁决 —— 顶栏不再显示任务名，改由这里（与左上浮动条）承载 */
  activeTitle: string
  onSelect: (id: string) => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
  onNewTask: () => void
  /** 收起本面板（收起后原位换成左上那条浮动条，见 Workspace） */
  onCollapse: () => void
  onInvite: () => void
  onFeedback: () => void
}

/**
 * 左侧任务面板（2026-09-21 用户裁决：由「点图标弹出的抽屉」升级为**常驻浮动面板**）。
 *
 * 结构沿用右侧面板的三段式（`.ws-panel-head` / `.ws-panel-scroll` / `.ws-panel-footer`）：
 * 头与脚不滚、中间列表滚 —— 面板浮在画布上时高度随视口变，只有中间滚才对。
 *
 * 每行任务**分两行**（标题 + 操作按钮 / 状态徽标）：面板只有 ~280px 宽，
 * 挤成一行时标题会被徽标与两个图标按钮压到只剩几十像素。
 *
 * 面板头是「当前任务名 + ＋新建任务 + 收起」：任务名原本挂在顶栏，2026-09-21 裁决挪到这里
 * （顶栏只留身份与额度），所以头部的标题是**当前选中任务**而不是「任务」这个分类名。
 */
function TopicPanel(p: Props) {
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  /** 重命名的校验提示：空名/纯空格时给出提示并**保持表单打开**（#83-1.4） */
  const [renameError, setRenameError] = useState<string | null>(null)

  const startRename = (id: string, title: string) => {
    setRenaming(id)
    setRenameValue(title)
    setRenameError(null)
  }

  return (
    <div className="ws-panel">
      <div className="ws-panel-head">
        <InlineText type="body-xs" className="ws-panel-label min-w-0 flex-1 truncate" title={p.activeTitle}>
          {p.activeTitle}
        </InlineText>
        <IconButton variant="secondary" size="sm" label="新建任务" onPress={p.onNewTask}>
          <Plus />
        </IconButton>
        <IconButton variant="secondary" size="sm" label="收起任务面板" onPress={p.onCollapse}>
          <ChevronLeft />
        </IconButton>
      </div>

      <div className="ws-panel-scroll">
        {p.topics.length === 0 && (
          <Typography type="body-sm" style={{ color: 'var(--muted)' }}>
            还没有任务，点上方「＋」新建一个。
          </Typography>
        )}
        {p.topics.map((t) => (
          <div key={t.id} className="ws-topic-item" data-active={t.id === p.activeId} onClick={() => p.onSelect(t.id)}>
            {renaming === t.id ? (
              <form
                className="flex w-full flex-col gap-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  // 空名/纯空格：给提示并**保持表单打开**，不静默关闭（#83-1.4）。
                  // 服务端 PATCH 也是 trim 后非空这一条规则，校验口径与它对齐。
                  const err = validateTopicTitle(renameValue)
                  if (err) {
                    setRenameError(err)
                    return
                  }
                  p.onRename(t.id, renameValue.trim())
                  setRenaming(null)
                  setRenameError(null)
                }}
              >
                <TextField
                  aria-label="任务名称"
                  className="w-full"
                  value={renameValue}
                  onChange={(v) => {
                    setRenameValue(v)
                    // 一旦开始改字就撤下提示：否则提示会停在屏幕上误导用户
                    setRenameError(null)
                  }}
                >
                  <Input autoFocus onClick={(e) => e.stopPropagation()} />
                </TextField>
                {renameError && (
                  <InlineText type="body-xs" role="alert" style={{ color: 'var(--danger-quiet)' }}>
                    {renameError}
                  </InlineText>
                )}
                <div className="flex gap-2">
                  <Button
                    type="submit"
                    variant="primary"
                    size="sm"
                    className="flex-1"
                    onClick={(e) => e.stopPropagation()}
                  >
                    保存
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="flex-1"
                    onClick={(e) => {
                      e.stopPropagation()
                      setRenaming(null)
                      setRenameError(null)
                    }}
                  >
                    取消
                  </Button>
                </div>
              </form>
            ) : (
              <>
                <div className="flex min-w-0 items-center gap-1.5">
                  <InlineText type="body-sm" className="min-w-0 flex-1 truncate">{t.title}</InlineText>
                  {/* ✎ / 🗑 原为文字字形与 emoji（emoji 还随平台变样），2026-09-21 换成图标库 + Tooltip */}
                  <IconButton
                    variant="secondary"
                    size="sm"
                    label="重命名任务"
                    onClick={(e) => {
                      e.stopPropagation()
                      startRename(t.id, t.title)
                    }}
                  >
                    <Pencil />
                  </IconButton>
                  <IconButton
                    variant="secondary"
                    size="sm"
                    label="删除任务"
                    onClick={(e) => {
                      e.stopPropagation()
                      p.onDelete(t.id)
                    }}
                  >
                    <TrashBin />
                  </IconButton>
                </div>
                <InlineText type="body-xs" className="ws-badge w-fit">{TOPIC_STATUS_LABEL[t.status] ?? t.status}</InlineText>
              </>
            )}
          </div>
        ))}
      </div>

      <div className="ws-panel-footer">
        <InviteEntry onPress={p.onInvite} />
        <Button variant="secondary" className="w-full" onPress={p.onFeedback}>
          提交反馈
        </Button>
      </div>
    </div>
  )
}

/**
 * 邀请入口：按「邀请好友送额度」开关显隐。
 * 首帧配置未到（`cfg === null`）时不渲染 —— 保守默认与「关闭」一致，
 * 避免出现「入口可见但拿不到奖励」。代价是开启时入口晚一帧出现。
 */
function InviteEntry({ onPress }: { onPress: () => void }) {
  const cfg = usePublicConfig()
  if (!cfg?.inviteRewardEnabled) return null
  return (
    <Button variant="secondary" className="w-full" onPress={onPress}>
      邀请好友（获得额度）
    </Button>
  )
}

export { TopicPanel }
