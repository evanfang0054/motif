'use client'

import { useEffect, useRef, useState } from 'react'
import { Drawer } from '@heroui/react'
import type { Topic } from '@motif/core'
import { TOPIC_STATUS_LABEL } from '@motif/core'

interface Props {
  topics: Topic[]
  activeId: string | null
  onSelect: (id: string) => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
  onClose: () => void
  onInvite: () => void
  onFeedback: () => void
}

/** 任务列表抽屉 */
function TaskDrawer(p: Props) {
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  // 无触发器上下文（由调用方条件挂载），关闭后还原焦点（GDD L4-2-G1-A1）
  const restoreRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    restoreRef.current = document.activeElement as HTMLElement | null
    return () => restoreRef.current?.focus?.()
  }, [])

  return (
    <Drawer.Backdrop
      isOpen
      onOpenChange={(open) => {
        if (!open) p.onClose()
      }}
    >
      <Drawer.Content placement="left" aria-label="任务列表">
        <Drawer.Dialog>
          <Drawer.Header>
            <Drawer.Heading>任务</Drawer.Heading>
            <Drawer.CloseTrigger aria-label="关闭任务列表">✕</Drawer.CloseTrigger>
          </Drawer.Header>
          <Drawer.Body className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
            {p.topics.length === 0 && (
              <p className="text-sm" style={{ color: 'var(--muted)' }}>
                还没有任务，点击下方按钮新建一个。
              </p>
            )}
            {p.topics.map((t) => (
              <div key={t.id} className="ws-topic-item" data-active={t.id === p.activeId} onClick={() => p.onSelect(t.id)}>
                {renaming === t.id ? (
                  <form
                    className="flex flex-1 gap-2"
                    onSubmit={(e) => {
                      e.preventDefault()
                      if (renameValue.trim()) p.onRename(t.id, renameValue.trim())
                      setRenaming(null)
                    }}
                  >
                    <input
                      className="lp-input"
                      value={renameValue}
                      autoFocus
                      onChange={(e) => setRenameValue(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                    />
                    <button
                      className="ws-btn ws-btn-primary"
                      type="submit"
                      onClick={(e) => e.stopPropagation()}
                    >
                      保存
                    </button>
                  </form>
                ) : (
                  <>
                    <span className="min-w-0 flex-1 truncate text-sm">{t.title}</span>
                    <span className="ws-badge">{TOPIC_STATUS_LABEL[t.status] ?? t.status}</span>
                    <button
                      className="ws-btn"
                      title="重命名任务"
                      onClick={(e) => {
                        e.stopPropagation()
                        setRenaming(t.id)
                        setRenameValue(t.title)
                      }}
                    >
                      ✎
                    </button>
                    <button
                      className="ws-btn"
                      title="删除任务"
                      onClick={(e) => {
                        e.stopPropagation()
                        p.onDelete(t.id)
                      }}
                    >
                      🗑
                    </button>
                  </>
                )}
              </div>
            ))}
          </Drawer.Body>
          <Drawer.Footer className="flex flex-col gap-2">
            <button className="ws-btn" onClick={p.onInvite} style={{ justifyContent: 'center' }}>
              邀请好友（获得额度）
            </button>
            <button className="ws-btn" onClick={p.onFeedback} style={{ justifyContent: 'center' }}>
              提交反馈
            </button>
          </Drawer.Footer>
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  )
}

export { TaskDrawer }
