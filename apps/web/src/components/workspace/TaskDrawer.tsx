'use client'

import { useState } from 'react'
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

  return (
    <>
      <div className="ws-drawer-mask" onClick={p.onClose} />
      <aside className="ws-drawer" role="dialog" aria-label="任务列表">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold">任务</h2>
          <button className="ws-btn" onClick={p.onClose} aria-label="关闭任务列表">✕</button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
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
        </div>

        <button className="ws-btn" onClick={p.onInvite} style={{ justifyContent: 'center' }}>
          邀请好友（获得额度）
        </button>
        <button className="ws-btn" onClick={p.onFeedback} style={{ justifyContent: 'center' }}>
          提交反馈
        </button>
      </aside>
    </>
  )
}

export { TaskDrawer }
