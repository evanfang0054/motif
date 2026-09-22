'use client'

import { useState } from 'react'
import { Button, Input, TextField } from '@heroui/react'
import { ChevronLeft, Pencil, Plus, TrashBin } from '@gravity-ui/icons'
import { IconButton } from '@/components/ui/icon-button'
import type { Topic } from '@motif/core'
import { TOPIC_STATUS_LABEL } from '@motif/core'

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

  return (
    <div className="ws-panel">
      <div className="ws-panel-head">
        <span className="ws-panel-label min-w-0 flex-1 truncate" title={p.activeTitle}>
          {p.activeTitle}
        </span>
        <IconButton variant="secondary" size="sm" label="新建任务" onPress={p.onNewTask}>
          <Plus />
        </IconButton>
        <IconButton variant="secondary" size="sm" label="收起任务面板" onPress={p.onCollapse}>
          <ChevronLeft />
        </IconButton>
      </div>

      <div className="ws-panel-scroll">
        {p.topics.length === 0 && (
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            还没有任务，点上方「＋」新建一个。
          </p>
        )}
        {p.topics.map((t) => (
          <div key={t.id} className="ws-topic-item" data-active={t.id === p.activeId} onClick={() => p.onSelect(t.id)}>
            {renaming === t.id ? (
              <form
                className="flex w-full flex-col gap-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  if (renameValue.trim()) p.onRename(t.id, renameValue.trim())
                  setRenaming(null)
                }}
              >
                <TextField aria-label="任务名称" className="w-full" value={renameValue} onChange={setRenameValue}>
                  <Input autoFocus onClick={(e) => e.stopPropagation()} />
                </TextField>
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
                    }}
                  >
                    取消
                  </Button>
                </div>
              </form>
            ) : (
              <>
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-sm">{t.title}</span>
                  {/* ✎ / 🗑 原为文字字形与 emoji（emoji 还随平台变样），2026-09-21 换成图标库 + Tooltip */}
                  <IconButton
                    variant="secondary"
                    size="sm"
                    label="重命名任务"
                    onClick={(e) => {
                      e.stopPropagation()
                      setRenaming(t.id)
                      setRenameValue(t.title)
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
                <span className="ws-badge w-fit">{TOPIC_STATUS_LABEL[t.status] ?? t.status}</span>
              </>
            )}
          </div>
        ))}
      </div>

      <div className="ws-panel-footer">
        <Button variant="secondary" className="w-full" onPress={p.onInvite}>
          邀请好友（获得额度）
        </Button>
        <Button variant="secondary" className="w-full" onPress={p.onFeedback}>
          提交反馈
        </Button>
      </div>
    </div>
  )
}

export { TopicPanel }
