'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { CanvasImage, GenerateImagesInput, StagedReference, Topic, TopicDetail, User } from '@motif/core'
import { MAX_REFERENCE_IMAGES, planReferenceAdd } from '@motif/core'
import { api } from '@/lib/client'
import { TEMPLATES } from '@/lib/templates'
import { TopNav } from './TopNav'
import { TemplateGallery } from './TemplateGallery'
import { CanvasStage } from '@/components/canvas/CanvasStage'
import { deleteImageConfirmText } from './canvas-geometry'
import { TaskPanel } from './TaskPanel'
import { TaskDrawer } from './TaskDrawer'
import { BillingDialog, FeedbackDialog, InviteDialog, ProfileDialog, RedeemDialog } from './dialogs'
import { PasswordHintBanner } from './PasswordHintBanner'
import { AlertDialog, Button, Spinner } from '@heroui/react'
import { showToast } from '@/components/ui/toast'

export interface PanelState {
  prompt: string
  count: number
  size: string
  customW: number
  customH: number
  referenceIds: string[]
  /** 暂存参考图（上传后、生成前；不进画布） */
  staged: StagedReference[]
  /** 刚上传文件的本地预览地址（刷新后失效，仅剩名称） */
  stagedPreviews: Record<string, string>
}

const IDLE_PANEL: PanelState = {
  prompt: '',
  count: 4,
  size: '1024x1024',
  customW: 1024,
  customH: 1024,
  referenceIds: [],
  staged: [],
  stagedPreviews: {},
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
  // 强制改密软提示仅本次会话可关闭；下次登录仍会提醒（标记仍在库里）
  const [passwordHintDismissed, setPasswordHintDismissed] = useState(false)
  const lastMsgStatusRef = useRef<string | null>(null)
  const detailRef = useRef<TopicDetail | null>(null)

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
          if (refund > 0) showToast({ tone: 'info', message: `任务已取消，未完成的 ${refund} 张额度已退回。`, timeoutMs: 6000 })
        } else if (active.status === 'failed') {
          showToast({ tone: 'danger', message: `生成失败：${active.error ?? '未知原因'}。`, timeoutMs: 6000 })
        } else if (active.status === 'completed') {
          showToast({ tone: 'success', message: '生成完成 ✓' })
        }
      }
      if (active) lastMsgStatusRef.current = active.status
      detailRef.current = d
      setDetail(d)
    },
    []
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
    void refreshDetail(activeId)
      .then((fresh) => {
        // 暂存参考以服务端为准同步进面板（本地预览 URL 不跨会话，只保留名称）
        const staged = fresh.staged ?? []
        setPanel((p) => ({
          ...p,
          staged,
          referenceIds: staged.map((s) => s.id),
          stagedPreviews: {},
        }))
      })
      .catch(() => setDetail(null))
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
      showToast({ tone: 'info', message: `已套用「${tpl.title}」模板` })
      // 额度预警前置：新用户余额往往小于模板张数，别等提交时才发现
      if (user.credits < tpl.count) {
        showToast({ tone: 'warning', message: `注意：「${tpl.title}」需 ${tpl.count} 张额度，当前余额 ${user.credits} 张；可调小张数或点击「充值」`, timeoutMs: 5200 })
      }
    },
    [user.credits]
  )

  const creatingRef = useRef(false)
  /** 确保存在活动任务：已有则直接复用 id；没有才向服务端创建/复用未使用任务（不动面板内容） */
  const ensureTopic = useCallback(async (): Promise<string | null> => {
    if (activeId) return activeId
    if (creatingRef.current) return null
    creatingRef.current = true
    try {
      const { topic, reused } = await fetch('/api/topics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '新任务' }),
      }).then((r) => r.json() as Promise<{ topic: Topic; reused: boolean }>)
      setActiveId(topic.id)
      await refreshTopics()
      if (reused) showToast({ tone: 'info', message: '已自动新建任务' })
      return topic.id
    } finally {
      creatingRef.current = false
    }
  }, [activeId, refreshTopics])

  /** 顶栏/抽屉「＋ 新任务」：真正新建（或复用空闲空任务）并切换过去 */
  const createTopic = useCallback(
    async () => {
      setDrawerOpen(false)
      setPanel(IDLE_PANEL)
      try {
        const { topic, reused } = await fetch('/api/topics', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: '新任务' }),
        }).then((r) => r.json() as Promise<{ topic: Topic; reused: boolean }>)
        setActiveId(topic.id)
        await refreshTopics()
        showToast({ tone: 'success', message: reused ? '已回到未使用的空任务' : '已创建新任务' })
      } catch {
        showToast({ tone: 'danger', message: '新任务创建失败，请重试' })
      }
    },
    [refreshTopics]
  )

  const busy = detail?.topic.status === 'pending' || detail?.topic.status === 'running' || detail?.topic.status === 'canceling'

  // 最近一次生成失败的信息（含退额说明）：持久展示在面板上，直到下次提交
  const lastError = useMemo(() => {
    if (!detail) return null
    const active = detail.messages.find((m) => m.id === detail.topic.activeMessageId) ?? detail.messages[detail.messages.length - 1]
    if (!active || active.status !== 'failed') return null
    return `上次生成失败：${active.error ?? '未知原因'}`
  }, [detail])

  const submitGenerate = useCallback(async () => {
    try {
      // 保证在明确的活动任务下提交（没有则自动创建），避免依赖服务端对空 topicId 的隐式处理
      const tid = await ensureTopic()
      const sentRefIds = [...panel.referenceIds]
      const res = await api.generate({
        prompt: panel.prompt,
        count: panel.count,
        size: panel.size === 'custom' ? `${panel.customW}x${panel.customH}` : panel.size,
        enhance: false,
        topicId: tid,
        referenceCanvasImageIds: sentRefIds,
      } satisfies GenerateImagesInput)
      setUser(res.user)
      setActiveId(res.topic.id)
      // 已提交的暂存参考被服务端转正为画布图：从面板暂存区移除（画布 @ 引用的 cimg_ 保留）
      setPanel((p) => ({
        ...p,
        staged: p.staged.filter((s) => !sentRefIds.includes(s.id)),
        referenceIds: p.referenceIds.filter((id) => !sentRefIds.includes(id)),
      }))
      await refreshTopics()
      await refreshDetail(res.topic.id)
      showToast({ tone: 'info', message: '任务已加入队列，后台生成中。' })
    } catch (e) {
      const msg = e instanceof Error ? e.message : '提交失败，请重试。'
      showToast({ tone: 'danger', message: msg, timeoutMs: 4000 })
      // 额度不足：光提示不够，直接把充值入口送到用户面前
      if (msg.includes('额度不足')) {
        setDialog('billing')
      }
    }
  }, [panel, activeId, ensureTopic, refreshTopics, refreshDetail])

  const cancelRunning = useCallback(async () => {
    if (!detail) return
    const msg = detail.messages.find((m) => m.id === detail.topic.activeMessageId)
    if (!msg) return
    try {
      await api.cancelMessage(msg.id)
      await refreshDetail(detail.topic.id)
      showToast({ tone: 'info', message: '已请求取消任务，正在停止后台生成。' })
    } catch (e) {
      showToast({ tone: 'danger', message: e instanceof Error ? e.message : '取消失败' })
    }
  }, [detail, refreshDetail])

  const renameTopic = useCallback(
    async (id: string, title: string) => {
      await api.renameTopic(id, title)
      await refreshTopics()
      if (activeId === id) await refreshDetail(id)
      showToast({ tone: 'success', message: '任务已重命名' })
    },
    [activeId, refreshDetail, refreshTopics]
  )

  const deleteTopic = useCallback(
    async (id: string) => {
      await api.deleteTopic(id)
      const list = await refreshTopics()
      if (activeId === id) setActiveId(list[0]?.id ?? null)
      showToast({ tone: 'success', message: '任务已删除' })
    },
    [activeId, refreshTopics]
  )

  const removeImages = useCallback(async (imgs: CanvasImage[]) => {
    await api.deleteCanvasImages(imgs.map((i) => i.id))
    if (activeId) await refreshDetail(activeId)
  }, [activeId, refreshDetail])

  /** 画布「@ 引用」：把图片加入参考图，并把 #编号 写进提示词（单张/批量同一条路径，按张准入） */
  const addReferencesFromCanvas = useCallback(
    (imgs: CanvasImage[]) => {
      if (imgs.length === 0) return
      const markerOf = (i: CanvasImage) => `#${String(i.serial).padStart(3, '0')}`
      // 在 setPanel 之外先算出准入结果：toast 文案要立刻用到它（不能依赖 updater 被同步调用）
      const plan = planReferenceAdd(panel.referenceIds, imgs.map((i) => i.id))
      if (plan.accepted.length > 0) {
        const admitted = new Set(plan.accepted)
        const freshMarkers = imgs.filter((i) => admitted.has(i.id)).map(markerOf)
        // 已写进提示词的编号不重复追加（与单图时的去重口径一致）
        const missing = freshMarkers.filter((m) => !panel.prompt.includes(m))
        const append = missing.map((m) => `${m} 作为参考图保持主体一致。`).join(' ')
        const prompt = append ? `${panel.prompt ? panel.prompt.replace(/\s+$/, '') + ' ' : ''}${append}` : panel.prompt
        setPanel((p) => ({ ...p, referenceIds: [...p.referenceIds, ...plan.accepted], prompt }))
      }
      // 逐张准入的三种结果分别给话：加进去了 / 本来就在 / 名额不够
      const parts: string[] = []
      if (plan.accepted.length > 0) {
        parts.push(
          plan.accepted.length === 1 && imgs.length === 1
            ? `已引用 ${markerOf(imgs[0])} 为参考图`
            : `已引用 ${plan.accepted.length} 张为参考图`
        )
      }
      if (plan.alreadyReferenced.length > 0 && plan.accepted.length === 0) parts.push('所选图片都已在参考图里了')
      if (plan.rejected.length > 0) {
        parts.push(`参考图最多 ${MAX_REFERENCE_IMAGES} 张，${plan.rejected.length} 张未加入`)
      }
      if (parts.length === 0) return
      showToast({ tone: 'info', message: parts.join('；') })
    },
    [panel.referenceIds, panel.prompt]
  )

  const uploadReference = useCallback(
    async (file: File) => {
      // 上限是「上传 + 引用」共用的总量：满了就先别让文件进服务端
      if (panel.referenceIds.length >= MAX_REFERENCE_IMAGES) {
        showToast({ tone: 'info', message: `参考图最多 ${MAX_REFERENCE_IMAGES} 张，请先移除一张再上传` })
        return
      }
      // 自动建任务：用户不必理解「任务」概念，上传动作本身就该可用
      const tid = await ensureTopic()
      if (!tid) {
        showToast({ tone: 'info', message: '请先新建一个任务' })
        return
      }
      try {
        const { reference } = await api.uploadReference(tid, file)
        // 只暂存（不进画布）：画布保持空态，模板画廊仍可选；生成时才转正
        const previewUrl = URL.createObjectURL(file)
        setPanel((p) => ({
          ...p,
          referenceIds: [...p.referenceIds, reference.id],
          staged: [...p.staged, reference],
          stagedPreviews: { ...p.stagedPreviews, [reference.id]: previewUrl },
        }))
        showToast({ tone: 'info', message: '参考图已暂存，点「开始生成」后进入画布' })
      } catch (e) {
        showToast({ tone: 'danger', message: e instanceof Error ? e.message : '上传失败' })
      }
    },
    [ensureTopic, panel.referenceIds.length]
  )

  /** 移除暂存参考（服务端删除 + 面板同步） */
  const removeStaged = useCallback(
    (id: string) => {
      setPanel((p) => ({
        ...p,
        referenceIds: p.referenceIds.filter((x) => x !== id),
        staged: p.staged.filter((s) => s.id !== id),
      }))
      void api.removeStagedReference(id).catch(() => showToast({ tone: 'danger', message: '暂存参考删除失败' }))
    },
    []
  )

  const logout = useCallback(async () => {
    await api.logout()
    router.refresh()
  }, [router])

  const onPaid = useCallback(
    async (user: User) => {
      setUser(user)
      setDialog(null)
      showToast({ tone: 'success', message: `支付成功，已充值 ${user.credits} 张总额度中的新额度` })
    },
    []
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

      {/* 改密入口即既有的个人资料弹窗（ProfileDialog 内含改密表单） */}
      <PasswordHintBanner
        show={!!user?.mustChangePassword && !passwordHintDismissed}
        onChangePassword={() => setDialog('profile')}
        onDismiss={() => setPasswordHintDismissed(true)}
      />

      <div className="ws-grid">
        <section className="ws-canvas">
          {detail && detail.canvasImages.length > 0 ? (
            <CanvasStage
              key={detail.topic.id}
              topicId={detail.topic.id}
              images={detail.canvasImages}
              onRemoveImages={(imgs) => setConfirmDelete({ kind: 'image', ids: imgs })}
              onAddReferences={addReferencesFromCanvas}
            />
          ) : (
            <TemplateGallery onSelect={selectTemplate} />
          )}
          {/* 生成进行中的全局浮层：画布暂无占位卡片，用一条轻量状态条告知「正在发生什么」 */}
          {busy && (
            <div
              role="status"
              aria-live="polite"
              style={{
                position: 'absolute',
                top: 12,
                left: '50%',
                transform: 'translateX(-50%)',
                zIndex: 20,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 16px',
                borderRadius: 999,
                border: '1px solid var(--border)',
                background: 'color-mix(in srgb, var(--surface-primary) 92%, transparent)',
                boxShadow: 'var(--shadow-soft)',
                fontSize: 13,
                color: 'var(--foreground)',
                pointerEvents: 'none',
              }}
            >
              <Spinner size="sm" />
              云端生成中，完成后图片会自动出现在画布
            </div>
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
            staged={panel.staged}
            stagedPreviews={panel.stagedPreviews}
            onRemoveStaged={removeStaged}
            busy={!!busy}
            credits={user.credits}
            lastError={lastError}
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
            <Button variant="secondary" onPress={() => setPanelOpen(true)}>展开生成面板</Button>
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
            showToast({ tone: 'success', message: '兑换成功，额度已到账' })
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
            showToast({ tone: 'success', message: '资料已更新' })
          }}
          onPasswordChanged={() => {
            setDialog(null)
            showToast({ tone: 'success', message: '密码已修改' })
          }}
        />
      )}
      {dialog === 'invite' && <InviteDialog user={user} onClose={() => setDialog(null)} />}
      {dialog === 'feedback' && (
        <FeedbackDialog
          onClose={() => setDialog(null)}
          onSent={() => {
            setDialog(null)
            showToast({ tone: 'success', message: '反馈已提交，感谢！' })
          }}
        />
      )}

      {confirmDelete && (
        <AlertDialog.Backdrop
          isOpen
          onOpenChange={(open) => {
            if (!open) setConfirmDelete(null)
          }}
        >
          <AlertDialog.Container>
            <AlertDialog.Dialog aria-label="删除确认">
              <AlertDialog.CloseTrigger aria-label="关闭" />
              <AlertDialog.Header>
                <AlertDialog.Icon status="danger" />
                <AlertDialog.Heading>{confirmDelete.kind === 'image' ? '删除图片' : '删除任务'}</AlertDialog.Heading>
              </AlertDialog.Header>
              <AlertDialog.Body>
                {confirmDelete.kind === 'image' ? (
                  <p className="text-sm" style={{ color: 'var(--muted)', lineHeight: 1.8 }}>
                    {deleteImageConfirmText(confirmDelete.ids.length)}
                    <br />
                    其余图片的编号保持不变，提示词里已写好的编号仍会指向原来的图片。
                  </p>
                ) : (
                  <p className="text-sm" style={{ color: 'var(--muted)', lineHeight: 1.8 }}>
                    将删除任务「{confirmDelete.title}」及其全部生成记录与图片，删除后无法恢复。
                  </p>
                )}
              </AlertDialog.Body>
              <AlertDialog.Footer>
                <Button slot="close" variant="secondary">取消</Button>
                <Button
                  variant="danger"
                  onPress={() => {
                    const target = confirmDelete
                    setConfirmDelete(null)
                    if (target.kind === 'image') void removeImages(target.ids)
                    else void deleteTopic(target.id)
                  }}
                >
                  删除
                </Button>
              </AlertDialog.Footer>
            </AlertDialog.Dialog>
          </AlertDialog.Container>
        </AlertDialog.Backdrop>
      )}
    </main>
  )
}

export { Workspace }
