'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { CanvasImage, GenerateImagesInput, StagedReference, Topic, TopicDetail, User } from '@motif/core'
import { MAX_REFERENCE_IMAGES, planReferenceAdd } from '@motif/core'
import { api } from '@/lib/client'
import { TEMPLATES } from '@/lib/templates'
import { TopNav } from './TopNav'
import { CanvasEmptyGuide } from './CanvasEmptyGuide'
import { CanvasStage } from '@/components/canvas/CanvasStage'
import { deleteImageConfirmText } from './canvas-geometry'
import { planRegenerateFromImage } from '@/lib/canvas/regenerate'
import { TaskPanel } from './TaskPanel'
import { TaskDrawer } from './TaskDrawer'
import { BillingDialog, FeedbackDialog, InviteDialog, ProfileDialog, RedeemDialog } from './dialogs'
import { PasswordHintBanner } from './PasswordHintBanner'
import { AlertDialog, Button, Spinner } from '@heroui/react'
import { showToast } from '@/components/ui/toast'
import { activeMessage, isBusyStatus, planTopicNotices, terminalNotice } from '@/lib/topic-notice'

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

/** 任务列表级监看的轮询间隔：只在有任务在跑时用（够快让人察觉，又不至于把接口打成心跳） */
const TOPIC_LIST_POLL_MS = 5000

/** 登录后工作台：顶栏 + 画布 + 右侧任务面板 + 任务抽屉 + 弹层 */
function Workspace({ initialUser }: { initialUser: User }) {
  const router = useRouter()
  const [user, setUser] = useState<User>(initialUser)
  const [topics, setTopics] = useState<Topic[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [detail, setDetail] = useState<TopicDetail | null>(null)
  const [panel, setPanel] = useState<PanelState>(IDLE_PANEL)
  const [drawerOpen, setDrawerOpen] = useState(false)
  /** 任务列表是否已加载完：用于区分「还在加载」与「确实一个任务都没有」 */
  const [topicsLoaded, setTopicsLoaded] = useState(false)
  /** 详情拉取失败：不能一直转圈（长轮询会继续重试，成功后自动复位） */
  const [detailFailed, setDetailFailed] = useState(false)
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
  /**
   * 当前任务 id 的镜像：`refreshTopics` 要靠它判断「这次结束的是不是当前任务」，
   * 但**不能**把 `activeId` 放进 `refreshTopics` 的 deps —— 初始化 effect 依赖它，
   * 且里面会 `setActiveId(list[0].id)`，身份一变就会在每次切任务时把用户强行拉回最近的任务。
   */
  const activeIdRef = useRef<string | null>(null)
  /** 上一次看到的各任务状态：只用于迁移检测，不参与渲染 */
  const topicStatusRef = useRef<Map<string, string>>(new Map())
  /** 列表请求序号：迟到的旧响应不许落地（否则状态快照回退 ⇒ 同一次结束被报两遍） */
  const listSeqRef = useRef(0)

  useEffect(() => {
    activeIdRef.current = activeId
  }, [activeId])

  /** 统一入口：写 detail 前检测消息状态迁移（取消/失败/完成），弹出对应提示 */
  const applyDetail = useCallback(
    (d: TopicDetail) => {
      const active = activeMessage(d)
      // 切换任务时不提示历史状态，只同步基线
      const topicChanged = detailRef.current !== null && detailRef.current.topic.id !== d.topic.id
      if (!topicChanged && lastMsgStatusRef.current && lastMsgStatusRef.current !== active?.status) {
        // 文案与后台任务路径（任务列表级监看）共用同一个纯函数：两处各写一份，改一处必漏另一处
        const notice = terminalNotice(d)
        if (notice) showToast(notice)
      }
      if (active) lastMsgStatusRef.current = active.status
      detailRef.current = d
      setDetail(d)
    },
    []
  )

  const refreshTopics = useCallback(async (): Promise<Topic[]> => {
    const seq = ++listSeqRef.current
    const { topics } = await api.listTopics()
    // 迟到的旧响应不许落地：否则状态快照会被回退成「在跑」，下一轮把同一次结束再报一遍
    if (seq < listSeqRef.current) return topics
    // 判定全在纯函数里（可单测）：非当前任务 + 从「在跑」落到「不在跑」才提示；
    // 返回的 next 必须写回 ref —— 它就是「同一次迁移只提示一次」的载体。
    // 读-改-写全程同步（中间没有 await），故「轮询与 watch/提交同时刷新」不会双份。
    const { finished, next } = planTopicNotices({ prev: topicStatusRef.current, topics, activeId: activeIdRef.current })
    topicStatusRef.current = next
    setTopics(topics)
    if (finished.length > 0) {
      // 不 await：submitGenerate / createTopic 都 await 本函数，把详情拉取塞进同步路径
      // 会拖慢「任务已加入队列」这类回执
      void (async () => {
        for (const t of finished) {
          try {
            const d = await api.topicDetail(t.id)
            const notice = terminalNotice(d, { title: t.title })
            if (notice) showToast(notice)
          } catch {
            // 详情拉不到就**不提示**：宁可少说，也不拿列表里的粗粒度状态编一句「已完成」
          }
        }
      })()
    }
    return topics
  }, [])

  const refreshDetail = useCallback(
    async (id: string): Promise<TopicDetail> => {
      const d = await api.topicDetail(id)
      applyDetail(d)
      // 成功即复位失败态：长轮询恢复后不必等用户点「重试」
      setDetailFailed(false)
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
      } finally {
        // 加载结束才置位：新手（一个任务都没有）也要落到空态引导，而不是一直转圈
        if (!cancelled) setTopicsLoaded(true)
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
      // 任务被删光后 activeId 变 null：不清失败位就会落进失败态，而那里没有可重试的 id（死按钮）
      setDetailFailed(false)
      return
    }
    void refreshDetail(activeId)
      .then((fresh) => {
        setDetailFailed(false)
        // 暂存参考以服务端为准同步进面板（本地预览 URL 不跨会话，只保留名称）
        const staged = fresh.staged ?? []
        setPanel((p) => ({
          ...p,
          staged,
          referenceIds: staged.map((s) => s.id),
          stagedPreviews: {},
        }))
      })
      .catch(() => {
        setDetailFailed(true)
        setDetail(null)
      })
  }, [activeId, refreshDetail])

  /**
   * 画布图被别处删掉时，面板里的参考关系要跟着摘掉。
   *
   * 本端删除走 `removeImages` 已同步清理，但别的标签页/会话删图只会经由长轮询把 detail 换掉：
   * 不在这里对账的话，残留的 `cimg_` 会让 `referenceCount` 虚高（可能误触上限），
   * 而且面板上根本没有入口能删掉它 —— 之后每次生成都返回 400「参考图不存在或不属于当前任务。」
   */
  useEffect(() => {
    if (!detail) return
    const alive = new Set(detail.canvasImages.map((i) => i.id))
    setPanel((p) => {
      const next = p.referenceIds.filter((id) => !id.startsWith('cimg_') || alive.has(id))
      return next.length === p.referenceIds.length ? p : { ...p, referenceIds: next }
    })
  }, [detail])

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
            // ⚠️ 这里到 refreshTopics 之间还有一次 /api/me 往返：用户中途切走时若不复检 stopped，
            // 循环会带着「已不是当前任务」的旧 id 继续刷新 —— 那条结束会被当成后台任务再报一遍
            if (stopped) return
            if (fresh.topic.status === 'idle') {
              const { user: u } = await api.me()
              if (stopped) return
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

  /**
   * 任务列表级监看：切到别的任务后，在跑的那个任务结束了也要有回执。
   *
   * 依赖是**布尔**而不是 `topics` 数组 —— 列表每次刷新不会重建定时器；空闲时**零请求**。
   * 取舍：本端全部空闲时不发请求，故别处（另一标签页）新启动的任务不会被发现，
   * 要等下一次列表刷新（提交 / 改名 / 删除 / 切任务）才可见。
   */
  const hasBusyTopic = topics.some((t) => isBusyStatus(t.status))
  useEffect(() => {
    if (!hasBusyTopic) return
    const timer = setInterval(() => {
      // 标签页在后台时不发请求：省掉没人看的轮询，回到前台的下一个 tick 自动追上
      if (typeof document !== 'undefined' && document.hidden) return
      void refreshTopics().catch(() => {})
    }, TOPIC_LIST_POLL_MS)
    return () => clearInterval(timer)
  }, [hasBusyTopic, refreshTopics])

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
    // 图片一删，引用关系就必须同步摘掉：服务端校验「参考图必须存在且属于本任务」，
    // 残留的 cimg_ 会让之后每一次生成都返回 400。
    const gone = new Set(imgs.map((i) => i.id))
    setPanel((p) => ({ ...p, referenceIds: p.referenceIds.filter((id) => !gone.has(id)) }))
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

  /** 取消画布引用：只摘参考关系，画布里的图仍在（与删图是两件事） */
  const removeCanvasReference = useCallback((id: string) => {
    setPanel((p) => ({ ...p, referenceIds: p.referenceIds.filter((x) => x !== id) }))
  }, [])

  /**
   * 「以它为参考再生成」：按该图**所属轮次的原始提示词**重填表单，并把参考图换成这张图。
   *
   * 与「@ 引用」的区别是**替换**（不是追加）；暂存参考与张数/尺寸都不动 —— 判定全在
   * `planRegenerateFromImage` 里（可单测），这里只负责落面板与回执。
   *
   * ⚠️ deps 必须含 `panel.prompt`：提示词是纯客户端 state，改它不会改变 `panel.staged` 的数组身份；
   * 只依赖 `panel.staged` 会闭包到旧提示词，把用户刚敲的正文写回成旧值。
   */
  const regenerateFrom = useCallback(
    (img: CanvasImage) => {
      const plan = planRegenerateFromImage({
        image: { id: img.id, serial: img.serial, messageId: img.messageId },
        messages: detail?.messages ?? [],
        currentPrompt: panel.prompt,
        stagedIds: panel.staged.map((s) => s.id),
        maxReferences: MAX_REFERENCE_IMAGES,
      })
      if (!plan.ok) {
        showToast({ tone: 'info', message: `参考图最多 ${MAX_REFERENCE_IMAGES} 张，暂存区已占满；先移除一张再重生成` })
        return
      }
      setPanel((p) => ({ ...p, prompt: plan.prompt, referenceIds: plan.referenceIds }))
      const marker = `#${String(img.serial).padStart(3, '0')}`
      const stagedCount = panel.staged.length
      showToast({
        tone: 'info',
        message: plan.reusedPrompt
          ? `已按 ${marker} 那一轮的提示词填好表单，参考图换成 ${marker}（原有画布引用已替换；张数与尺寸沿用当前设置）`
          : stagedCount > 0
            ? `已把 ${marker} 设为画布参考图（原有画布引用已替换；没有可复用的提示词，提示词未改动；暂存区 ${stagedCount} 张仍会一起提交）`
            : `已把 ${marker} 设为唯一参考图（原有画布引用已替换；没有可复用的提示词，提示词未改动）`,
        timeoutMs: 6000,
      })
    },
    [detail, panel.staged, panel.prompt]
  )

  /** 面板里要展示的画布引用：已在参考图里、且不在暂存区的画布图 */
  const canvasReferences = useMemo(() => {
    const stagedIds = new Set(panel.staged.map((s) => s.id))
    return (detail?.canvasImages ?? []).filter((i) => panel.referenceIds.includes(i.id) && !stagedIds.has(i.id))
  }, [detail, panel.referenceIds, panel.staged])

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
          {/* 四态：等列表/等详情 → Spinner；详情拉取失败 → 失败态 + 重试；有图 → 画布；
              无图（含新手一个任务都没有）→ 新手引导。
              ⚠️ 失败态必须与空态分开：拉取失败时 `detail` 已被置空，若复用空态引导就会**对有图的任务
              说「画布现在是空的」**（假陈述）。失败态只承诺两件事：不撒谎 + 给一个重试入口。
              注意 `detail` 在失败时被清掉，所以画布仍会被卸载（内存里的选中与拖拽保不住）——
              要保住画布得改成「失败时保留旧 detail」，那是另一件事，不在本轮范围。
              模板入口已收敛到右侧表单。 */}
          {!topicsLoaded || (activeId !== null && detail === null && !detailFailed) ? (
            <div className="flex h-full items-center justify-center">
              <Spinner />
            </div>
          ) : detail === null && detailFailed ? (
            <div className="flex h-full flex-col items-center justify-center gap-3">
              <p className="text-sm" style={{ color: 'var(--muted)' }}>画布加载失败，请检查网络后重试。</p>
              <Button
                variant="secondary"
                onPress={() => {
                  if (activeId) void refreshDetail(activeId).then(() => setDetailFailed(false)).catch(() => {})
                }}
              >
                重试
              </Button>
            </div>
          ) : detail && detail.canvasImages.length > 0 ? (
            <CanvasStage
              key={detail.topic.id}
              topicId={detail.topic.id}
              images={detail.canvasImages}
              messages={detail.messages}
              onRemoveImages={(imgs) => setConfirmDelete({ kind: 'image', ids: imgs })}
              onAddReferences={addReferencesFromCanvas}
              onRegenerate={regenerateFrom}
            />
          ) : (
            <CanvasEmptyGuide onSelectTemplate={selectTemplate} />
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
            canvasReferences={canvasReferences}
            onRemoveStaged={removeStaged}
            onRemoveCanvasReference={removeCanvasReference}
            busy={!!busy}
            credits={user.credits}
            lastError={lastError}
            onPromptChange={(prompt) => setPanel((p) => ({ ...p, prompt }))}
            onCountChange={(count) => setPanel((p) => ({ ...p, count }))}
            onSizeChange={(size) => setPanel((p) => ({ ...p, size }))}
            onCustomSizeChange={(w, h) => setPanel((p) => ({ ...p, customW: w, customH: h }))}
            onUploadReference={(f) => void uploadReference(f)}
            onSelectTemplate={selectTemplate}
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
