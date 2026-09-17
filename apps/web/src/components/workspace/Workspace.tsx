'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { CanvasImage, GenerateImagesInput, Topic, TopicDetail, User } from '@motif/core'
import { api } from '@/lib/client'
import { TEMPLATES } from '@/lib/templates'
import { TopNav } from './TopNav'
import { TemplateGallery } from './TemplateGallery'
import { CanvasBoard } from './CanvasBoard'
import { deleteImageConfirmText } from './canvas-geometry'
import { TaskPanel } from './TaskPanel'
import { TaskDrawer } from './TaskDrawer'
import { BillingDialog, FeedbackDialog, InviteDialog, ProfileDialog, RedeemDialog } from './dialogs'

export interface PanelState {
  prompt: string
  count: number
  size: string
  customW: number
  customH: number
  referenceIds: string[]
}

const IDLE_PANEL: PanelState = {
  prompt: '',
  count: 4,
  size: '1024x1024',
  customW: 1024,
  customH: 1024,
  referenceIds: [],
}

/** 登录后工作台：顶栏 + 画布 + 右侧任务面板 + 任务抽屉 + 弹层 */
function Workspace({ initialUser }: { initialUser: User }) {
  const router = useRouter()
  const [user, setUser] = useState<User>(initialUser)
  const [topics, setTopics] = useState<Topic[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [detail, setDetail] = useState<TopicDetail | null>(null)
  const [panel, setPanel] = useState<PanelState>(IDLE_PANEL)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [dialog, setDialog] = useState<'billing' | 'redeem' | 'invite' | 'feedback' | 'profile' | null>(null)
  const [panelOpen, setPanelOpen] = useState(true)
  const [confirmDelete, setConfirmDelete] = useState<
    | { kind: 'image'; ids: CanvasImage[] }
    | { kind: 'topic'; id: string; title: string }
    | null
  >(null)
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastMsgStatusRef = useRef<string | null>(null)
  const detailRef = useRef<TopicDetail | null>(null)

  const showToast = useCallback((msg: string, dwellMs = 2600) => {
    setToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    // 失败/退款等重要提示驻留更久，普通操作反馈保持轻量
    toastTimer.current = setTimeout(() => setToast(null), dwellMs)
  }, [])

  /** 统一入口：写 detail 前检测消息状态迁移（取消/失败/完成），弹出对应提示 */
  const applyDetail = useCallback(
    (d: TopicDetail) => {
      const active = d.messages.find((m) => m.id === d.topic.activeMessageId) ?? d.messages[d.messages.length - 1]
      // 切换任务时不提示历史状态，只同步基线
      const topicChanged = detailRef.current !== null && detailRef.current.topic.id !== d.topic.id
      if (active && !topicChanged && lastMsgStatusRef.current && lastMsgStatusRef.current !== active.status) {
        if (active.status === 'canceled') {
          const done = d.canvasImages.filter((i) => i.messageId === active.id).length
          const refund = active.requestedCount - done
          if (refund > 0) showToast(`任务已取消，未完成的 ${refund} 张额度已退回。`, 6000)
        } else if (active.status === 'failed') {
          showToast(`生成失败：${active.error ?? '未知原因'}。`, 6000)
        } else if (active.status === 'completed') {
          showToast('生成完成 ✓')
        }
      }
      if (active) lastMsgStatusRef.current = active.status
      detailRef.current = d
      setDetail(d)
    },
    [showToast]
  )

  const refreshTopics = useCallback(async (): Promise<Topic[]> => {
    const { topics } = await api.listTopics()
    setTopics(topics)
    return topics
  }, [])

  const refreshDetail = useCallback(
    async (id: string): Promise<TopicDetail> => {
      const d = await api.topicDetail(id)
      applyDetail(d)
      return d
    },
    [applyDetail]
  )

  // 初始化：加载任务列表并选中最近一个
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const list = await refreshTopics()
        if (!cancelled && list.length > 0) {
          setActiveId(list[0].id)
        }
      } catch {
        // 未登录时由页面服务端组件兜底
      }
    })()
    return () => {
      cancelled = true
    }
  }, [refreshTopics])

  // 切换任务时拉详情并同步面板基础状态
  useEffect(() => {
    if (!activeId) {
      setDetail(null)
      return
    }
    void refreshDetail(activeId).catch(() => setDetail(null))
  }, [activeId, refreshDetail])

  // 长轮询 watch：任务状态变化时立即刷新（替代固定间隔轮询）
  useEffect(() => {
    if (!activeId) return
    let stopped = false
    const ac = new AbortController()
    void (async () => {
      while (!stopped) {
        const since = detailRef.current?.topic.id === activeId ? detailRef.current.topic.updatedAt : ''
        try {
          const r = await api.watchTopic(activeId, since, ac.signal)
          if (stopped) return
          if (r.changed) {
            const fresh = await refreshDetail(activeId)
            if (fresh.topic.status === 'idle') {
              const { user: u } = await api.me()
              if (u) setUser(u)
              void refreshTopics()
            }
          }
        } catch {
          if (stopped) return
          await new Promise((r) => setTimeout(r, 1500))
        }
      }
    })()
    return () => {
      stopped = true
      ac.abort()
    }
  }, [activeId, refreshDetail, refreshTopics])

  const selectTemplate = useCallback(
    (key: string) => {
      const tpl = TEMPLATES.find((t) => t.key === key)
      if (!tpl) return
      setPanel((p) => ({
        ...p,
        prompt: tpl.prompt,
        count: tpl.count,
        size: tpl.size,
        referenceIds: p.referenceIds,
      }))
      showToast(`已套用「${tpl.title}」模板`)
    },
    [showToast]
  )

  const busy = detail?.topic.status === 'pending' || detail?.topic.status === 'running' || detail?.topic.status === 'canceling'

  const submitGenerate = useCallback(async () => {
    try {
      const res = await api.generate({
        prompt: panel.prompt,
        count: panel.count,
        size: panel.size === 'custom' ? `${panel.customW}x${panel.customH}` : panel.size,
        enhance: false,
        topicId: activeId,
        referenceCanvasImageIds: panel.referenceIds,
      } satisfies GenerateImagesInput)
      setUser(res.user)
      setActiveId(res.topic.id)
      await refreshTopics()
      await refreshDetail(res.topic.id)
      showToast('任务已加入队列，后台生成中。')
    } catch (e) {
      showToast(e instanceof Error ? e.message : '提交失败，请重试。', 4000)
    }
  }, [panel, activeId, refreshTopics, refreshDetail, showToast])

  const cancelRunning = useCallback(async () => {
    if (!detail) return
    const msg = detail.messages.find((m) => m.id === detail.topic.activeMessageId)
    if (!msg) return
    try {
      await api.cancelMessage(msg.id)
      await refreshDetail(detail.topic.id)
      showToast('已请求取消任务，正在停止后台生成。')
    } catch (e) {
      showToast(e instanceof Error ? e.message : '取消失败')
    }
  }, [detail, refreshDetail, showToast])

  const creatingRef = useRef(false)
  const createTopic = useCallback(async () => {
    if (creatingRef.current) return // 防连点：进行中忽略后续点击
    creatingRef.current = true
    try {
      const { topic, reused } = await fetch('/api/topics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '新任务' }),
      }).then((r) => r.json() as Promise<{ topic: Topic; reused: boolean }>)
      setPanel(IDLE_PANEL)
      setActiveId(topic.id)
      await refreshTopics()
      setDrawerOpen(false)
      showToast(reused ? '已回到未使用的任务' : '已新建任务')
    } finally {
      creatingRef.current = false
    }
  }, [refreshTopics, showToast])

  const renameTopic = useCallback(
    async (id: string, title: string) => {
      await api.renameTopic(id, title)
      await refreshTopics()
      if (activeId === id) await refreshDetail(id)
      showToast('任务已重命名')
    },
    [activeId, refreshDetail, refreshTopics, showToast]
  )

  const deleteTopic = useCallback(
    async (id: string) => {
      await api.deleteTopic(id)
      const list = await refreshTopics()
      if (activeId === id) setActiveId(list[0]?.id ?? null)
      showToast('任务已删除')
    },
    [activeId, refreshTopics, showToast]
  )

  const removeImages = useCallback(async (imgs: CanvasImage[]) => {
    await api.deleteCanvasImages(imgs.map((i) => i.id))
    if (activeId) await refreshDetail(activeId)
  }, [activeId, refreshDetail])

  /** 画布「@ 引用」：把图片加入参考图，并把 #编号 写进提示词 */
  const addReferenceFromCanvas = useCallback(
    (img: CanvasImage) => {
      const serial = `#${String(img.serial).padStart(3, '0')}`
      setPanel((p) => {
        if (p.referenceIds.includes(img.id)) return p
        const prompt = p.prompt.includes(serial) ? p.prompt : `${p.prompt ? p.prompt.replace(/\s+$/, '') + ' ' : ''}${serial} 作为参考图保持主体一致。`
        return { ...p, referenceIds: [...p.referenceIds, img.id], prompt }
      })
      showToast(`已引用 ${serial} 为参考图`)
    },
    [showToast]
  )

  const uploadReference = useCallback(
    async (file: File) => {
      if (!activeId) {
        showToast('请先新建一个任务')
        return
      }
      try {
        const { canvasImage } = await api.uploadReference(activeId, file)
        setPanel((p) => ({ ...p, referenceIds: [...p.referenceIds, canvasImage.id] }))
        await refreshDetail(activeId)
        showToast('参考图已上传')
      } catch (e) {
        showToast(e instanceof Error ? e.message : '上传失败')
      }
    },
    [activeId, refreshDetail, showToast]
  )

  const logout = useCallback(async () => {
    await api.logout()
    router.refresh()
  }, [router])

  const onPaid = useCallback(
    async (user: User) => {
      setUser(user)
      setDialog(null)
      showToast(`支付成功，已充值 ${user.credits} 张总额度中的新额度`)
    },
    [showToast]
  )

  return (
    <main className="ws-shell">
      <TopNav
        user={user}
        topicTitle={detail?.topic.title ?? '新任务'}
        onOpenTasks={() => setDrawerOpen(true)}
        onNewTask={() => void createTopic()}
        onOpenBilling={() => setDialog('billing')}
        onOpenProfile={() => setDialog('profile')}
        onLogout={() => void logout()}
      />

      <div className="ws-grid">
        <section className="ws-canvas">
          {detail && detail.canvasImages.length > 0 ? (
            <CanvasBoard
              key={detail.topic.id}
              images={detail.canvasImages}
              onRemoveImages={(imgs) => setConfirmDelete({ kind: 'image', ids: imgs })}
              onAddReference={(img) => addReferenceFromCanvas(img)}
            />
          ) : (
            <TemplateGallery onSelect={selectTemplate} />
          )}
        </section>

        {panelOpen ? (
          <TaskPanel
            status={detail?.topic.status ?? 'idle'}
            prompt={panel.prompt}
            count={panel.count}
            size={panel.size}
            customW={panel.customW}
            customH={panel.customH}
            referenceCount={panel.referenceIds.length}
            busy={!!busy}
            onPromptChange={(prompt) => setPanel((p) => ({ ...p, prompt }))}
            onCountChange={(count) => setPanel((p) => ({ ...p, count }))}
            onSizeChange={(size) => setPanel((p) => ({ ...p, size }))}
            onCustomSizeChange={(w, h) => setPanel((p) => ({ ...p, customW: w, customH: h }))}
            onUploadReference={(f) => void uploadReference(f)}
            onGenerate={() => void submitGenerate()}
            onCancel={() => void cancelRunning()}
            onNewTask={() => void createTopic()}
            onCollapse={() => setPanelOpen(false)}
          />
        ) : (
          <div className="lg:hidden">
            <button className="ws-btn" onClick={() => setPanelOpen(true)}>展开生成面板</button>
          </div>
        )}
      </div>

      {drawerOpen && (
        <TaskDrawer
          topics={topics}
          activeId={activeId}
          onSelect={(id) => {
            setActiveId(id)
            setDrawerOpen(false)
          }}
          onRename={(id, t) => void renameTopic(id, t)}
          onDelete={(id) => {
            const t = topics.find((x) => x.id === id)
            setConfirmDelete({ kind: 'topic', id, title: t?.title ?? '该任务' })
          }}
          onClose={() => setDrawerOpen(false)}
          onInvite={() => {
            setDrawerOpen(false)
            setDialog('invite')
          }}
          onFeedback={() => {
            setDrawerOpen(false)
            setDialog('feedback')
          }}
        />
      )}

      {dialog === 'billing' && (
        <BillingDialog
          onClose={() => setDialog(null)}
          onPaid={(u) => void onPaid(u)}
          onRedeem={() => setDialog('redeem')}
        />
      )}
      {dialog === 'redeem' && (
        <RedeemDialog
          onClose={() => setDialog(null)}
          onRedeemed={(u) => {
            setUser(u)
            setDialog(null)
            showToast('兑换成功，额度已到账')
          }}
        />
      )}
      {dialog === 'profile' && (
        <ProfileDialog
          user={user}
          onClose={() => setDialog(null)}
          onSaved={(u) => {
            setUser(u)
            setDialog(null)
            showToast('资料已更新')
          }}
          onPasswordChanged={() => {
            setDialog(null)
            showToast('密码已修改')
          }}
        />
      )}
      {dialog === 'invite' && <InviteDialog user={user} onClose={() => setDialog(null)} />}
      {dialog === 'feedback' && (
        <FeedbackDialog
          onClose={() => setDialog(null)}
          onSent={() => {
            setDialog(null)
            showToast('反馈已提交，感谢！')
          }}
        />
      )}

      {confirmDelete && (
        <div className="ws-modal-mask" onClick={() => setConfirmDelete(null)}>
          <div className="ws-modal" role="dialog" aria-label="删除确认" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-base font-bold">{confirmDelete.kind === 'image' ? '删除图片' : '删除任务'}</h2>
            {confirmDelete.kind === 'image' ? (
              <p className="mt-3 text-sm" style={{ color: 'var(--muted)', lineHeight: 1.8 }}>
                {deleteImageConfirmText(confirmDelete.ids.length)}
                <br />
                其余图片的编号保持不变，提示词里已写好的编号仍会指向原来的图片。
              </p>
            ) : (
              <p className="mt-3 text-sm" style={{ color: 'var(--muted)', lineHeight: 1.8 }}>
                将删除任务「{confirmDelete.title}」及其全部生成记录与图片，删除后无法恢复。
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button className="ws-btn" onClick={() => setConfirmDelete(null)}>取消</button>
              <button
                className="ws-btn"
                style={{ background: 'var(--danger)', color: 'var(--danger-text)', borderColor: 'transparent' }}
                onClick={() => {
                  const target = confirmDelete
                  setConfirmDelete(null)
                  if (target.kind === 'image') void removeImages(target.ids)
                  else void deleteTopic(target.id)
                }}
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="ws-toast" role="status">
          {toast}
        </div>
      )}
    </main>
  )
}

export { Workspace }
