'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { CanvasImage, GenerateImagesInput, StagedReference, Topic, TopicDetail, User } from '@motif/core'
import { MAX_REFERENCE_IMAGES, planReferenceAdd, isSessionExpiredStatus, validatePrompt } from '@motif/core'
import { api, ApiError } from '@/lib/client'
import { usePublicConfig } from '@/lib/use-public-config'
import { useMediaQuery, WIDE_QUERY } from '@/lib/use-media-query'
import { TopNav } from './TopNav'
import { sizeLabelOf } from '@/lib/templates'
import { LayoutSideContentLeft, LayoutSideContentRight, Plus } from '@gravity-ui/icons'
import { IconButton } from '@/components/ui/icon-button'
import { CanvasEmptyGuide } from './CanvasEmptyGuide'
import { CanvasStage } from '@/components/canvas/CanvasStage'
import { deleteImageConfirmText } from './canvas-geometry'
import { planRegenerateFromImage } from '@/lib/canvas/regenerate'
import { pendingSkeletonSlots } from '@/lib/canvas/skeleton'
import { TaskPanel } from './TaskPanel'
import { TopicPanel } from './TopicPanel'
import { BillingDialog, FeedbackDialog, InviteDialog, ProfileDialog, RedeemDialog } from './dialogs'
import { PromptLibraryModal } from './PromptLibraryModal'
import type { PromptLibraryEntry } from '@/lib/client'
import { PasswordHintBanner } from './PasswordHintBanner'
import { clearHintDismissed, sessionStore } from '@/lib/password-hint'
import { AlertDialog, Button, Spinner, Typography } from '@heroui/react'
import { InlineText } from '@/components/ui/typography'
import { showToast } from '@/components/ui/toast'
import { activeMessage, isBusyStatus, planTopicNotices, terminalNotice } from '@/lib/topic-notice'
import { planRetryFromMessage } from '@/lib/retry'

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
  /* 张数默认 1（2026-09-21 用户裁决）：默认值原先是 4。
     4 张是**四倍的扣额**，而多数时候用户只想先出一张看看效果；
     要批量再自己加，比「默认多花钱、发现不对再减」安全。 */
  count: 1,
  /* 尺寸默认「自动」（2026-09-21 用户裁决）：默认值原先是 1024×1024（方图），
     但「方图」是一个**具体的构图承诺**，而多数提示词并不要求方形 ——
     默认成自动（由模型按提示词决定，见 core/validation.ts 里 auto 的兜底 1024×1024）才不会
     让用户在没注意尺寸的时候被动接受一个方形构图。 */
  size: 'auto',
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
  // 提示词增强由服务端全局配置决定（D13：不做用户侧开关）——前端只跟随，不提供控件。
  // 服务端仍会再 AND 一次配置，所以这里传错也不会真的打到未配置的 LLM。
  const publicCfg = usePublicConfig()
  const router = useRouter()
  const [user, setUser] = useState<User>(initialUser)
  /**
   * 余额写回的「后发优先」护栏。
   *
   * `/api/me` 是异步读：若它在一次扣费**之前**读到库、却在扣费响应之后才 resolve，就会把顶部
   * 余额写回旧值，且下一次纠正要等到「又有任务结束」。`topics` 早有 `listSeqRef` 防这件事，
   * `user` 一直缺 —— 故所有写入口都走 `applyUser`，由它保证只有最新一次写入生效。
   */
  const userSeqRef = useRef(0)
  const applyUser = useCallback((u: User | null) => {
    if (!u) return
    userSeqRef.current += 1
    setUser(u)
  }, [])
  /** 从 `/api/me` 拉一次余额（best-effort：失败只丢弃本次，不冒泡成调用方的失败） */
  const refreshUser = useCallback(async () => {
    const seq = ++userSeqRef.current
    try {
      const { user: u } = await api.me()
      // 期间若有更新的写入（扣费 / 充值 / 改资料响应），丢弃这次读到的旧余额
      if (seq === userSeqRef.current) applyUser(u)
    } catch {
      // 静默：余额刷新失败不该让「取消生成」这类操作被报成失败
    }
  }, [applyUser])
  const [topics, setTopics] = useState<Topic[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [detail, setDetail] = useState<TopicDetail | null>(null)
  const [panel, setPanel] = useState<PanelState>(IDLE_PANEL)
  /**
   * 两侧浮动面板的展开态。`null` = 还不知道屏幕多宽（SSR / hydration 首帧）→ 先不渲染面板。
   *
   * 2026-09-21 用户裁决：宽屏（≥1024）**默认展开**、窄屏**默认收起**（窄屏展开时面板铺满画布 + 遮罩）。
   * 宽度由 `useMediaQuery` 给（它用 useSyncExternalStore，hydration 后同帧修正，不会闪）。
   */
  const wide = useMediaQuery(WIDE_QUERY)
  const [leftOpen, setLeftOpen] = useState<boolean | null>(null)
  const [rightOpen, setRightOpen] = useState<boolean | null>(null)
  /** 任务列表是否已加载完：用于区分「还在加载」与「确实一个任务都没有」 */
  const [topicsLoaded, setTopicsLoaded] = useState(false)
  /** 详情拉取失败：不能一直转圈（长轮询会继续重试，成功后自动复位） */
  const [detailFailed, setDetailFailed] = useState(false)
  /**
   * 会话已失效（401 / 404）。
   *
   * 401 = 登录过期、404 = 任务已不存在：两者都不该继续轮询（#83-1.6 / #73-1.4 同源），
   * 否则 watch 会变成对失效资源的无间隔请求风暴，而用户只看到「网络抖动」。
   * 置位后终止 watch 并给出「登录已过期」的明确出口（重新登录）。
   */
  const [sessionExpired, setSessionExpired] = useState(false)
  const [dialog, setDialog] = useState<'billing' | 'redeem' | 'invite' | 'feedback' | 'profile' | 'promptLibrary' | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<
    | { kind: 'image'; ids: CanvasImage[] }
    | { kind: 'topic'; id: string; title: string }
    | null
  >(null)
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
  /**
   * 详情请求序号：**迟到的响应不许落地**（两种后果都由它兜住）。
   *
   * ① 迟到的**失败**：A（已加载）→ 点 B → 立刻点回 A，B 的 reject 随后才到，那句 catch 会按
   *    「换了任务」把 A 的画布清空 —— 正是 #85-1.2 要消掉的「画布突然变空」，触发者是**已经离开的任务**。
   * ② 迟到的**成功**：同场景下 B 的响应后到会把 `detail` 写成 B —— 画布显示 B 的图而 `activeId` 是 A；
   *    更糟的是 `detailRef` 变成 B 后，长轮询算出的 `since` 是空串，而 watch 路由对空 `since`
   *    **立即返回** `changed:false` ⇒ 无间隔请求风暴，且不会自愈。
   *
   * 序号由**发起方**自增（切任务 effect 与 `retryDetail`），不放进 `refreshDetail` 内部 ——
   * 它同时被 `submitGenerate` / `renameTopic` 这类用户动作调用，那些必须无条件落地。
   */
  const detailSeqRef = useRef(0)

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
      // 后台任务结束 = 可能发生了退额（取消 / 失败 / 部分完成），余额必须当场回正，
      // 否则顶部读数会一直停在扣费后的值，直到用户手动刷新。
      void refreshUser()
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

  /**
   * 拉详情并落地。
   *
   * `seq` 是**发起方**的请求序号（见 `detailSeqRef`）：不等于当前序号即视为已被更新的请求取代，
   * 既不落地也不回给调用方（返回 `null`）。
   * 不传 `seq` 表示「无条件落地」—— `submitGenerate` / `renameTopic` / `cancelRunning` /
   * `removeImages` 由用户动作直接触发，长轮询自带 `stopped` 守卫，都不该被序号误伤。
   */
  const refreshDetail = useCallback(
    async (id: string, seq?: number): Promise<TopicDetail | null> => {
      const d = await api.topicDetail(id)
      if (seq !== undefined && seq !== detailSeqRef.current) return null
      applyDetail(d)
      // 成功即复位失败态：长轮询恢复后不必等用户点「重试」
      setDetailFailed(false)
      return d
    },
    [applyDetail]
  )

  /**
   * 把一次成功拉取的详情同步进面板（暂存参考以服务端为准；本地预览 URL 不跨会话，只保留名称）。
   * ⚠️ 会**整体替换** `referenceIds`，只在「换了任务」或「画布已被清空」时才成立 ——
   * 同一任务的重试里调用它会把用户用「@ 引用」加的画布参考图摘掉，下一次生成静默少图。
   */
  const applyFreshDetail = useCallback((fresh: TopicDetail) => {
    const staged = fresh.staged ?? []
    setPanel((p) => ({ ...p, staged, referenceIds: staged.map((s) => s.id), stagedPreviews: {} }))
  }, [])

  /**
   * 失败态与顶部提示条共用的「重试」。
   * 失败位由 `refreshDetail` 在成功时复位，这里只需在再次失败时**保持**失败位（`detail` 原样保留）。
   */
  const retryDetail = useCallback(() => {
    if (!activeId) return
    const seq = ++detailSeqRef.current
    void refreshDetail(activeId, seq)
      .then((fresh) => {
        // 只有「画布已被清空」的失败态才重置面板（见 `applyFreshDetail` 的告警）
        if (fresh && detail === null) applyFreshDetail(fresh)
      })
      .catch(() => {
        if (seq === detailSeqRef.current) setDetailFailed(true)
      })
  }, [activeId, detail, refreshDetail, applyFreshDetail])

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
    const seq = ++detailSeqRef.current
    // 换任务即视为「失败态未知」，由这次请求的结果决定 —— 否则上一个任务的失败提示会闪在新任务上
    setDetailFailed(false)
    void refreshDetail(activeId, seq)
      .then((fresh) => {
        // 被更新的请求取代时 `refreshDetail` 返回 null（迟到的成功不许落地，见 `detailSeqRef`）
        if (fresh) applyFreshDetail(fresh)
      })
      .catch(() => {
        // ⚠️ 迟到的失败不许落地：A→B→A 时 B 的 reject 若按「换了任务」处理，会把 A 的画布清空 ——
        // 那正是 #85-1.2 要消掉的「画布突然变空」，只不过触发者是**已经离开的任务**。
        if (seq !== detailSeqRef.current) return
        setDetailFailed(true)
        // **刻意不清空 detail**（#85-1.2）：清空会让画布与面板瞬间变空。
        // 保留**同一任务**的旧数据，失败由 `detailFailed` 表达（顶部提示条 + 重试）。
        // 换了任务则必须清 —— 否则会把上一个任务的画布当成新任务的显示出来。
        setDetail((d) => (d && d.topic.id === activeId ? d : null))
      })
  }, [activeId, refreshDetail, applyFreshDetail])

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
    // 会话已失效就不要再拉起 watch：接口只会一直 401（首个 401 后循环虽会自停，
    // 但切任务会重新挂一轮、白跑一次请求）。判据与下方列表轮询的 `sessionExpired` 守卫一致。
    if (!activeId || sessionExpired) return
    let stopped = false
    const ac = new AbortController()
    void (async () => {
      while (!stopped) {
        const since = detailRef.current?.topic.id === activeId ? detailRef.current.topic.updatedAt : ''
        // ⚠️ `since` 为空串时 watch 路由是**立即返回** `changed:false`（那是「给我基线」的语义）——
        // 不 sleep 就会变成对 /watch 的无间隔请求风暴。正常切任务时这个窗口只有几十毫秒，
        // 但一旦 `detailRef` 被写成别的任务（见 `detailSeqRef` 的说明）就会一直空转，故这里兜一道。
        if (!since) await new Promise((r) => setTimeout(r, 1000))
        if (stopped) return
        try {
          const r = await api.watchTopic(activeId, since, ac.signal)
          if (stopped) return
          if (r.changed) {
            let fresh: TopicDetail | null
            try {
              fresh = await refreshDetail(activeId)
            } catch {
              // 详情拉取失败：**画布保留旧内容**，用顶部提示条如实告知（#85-1.2）。
              // 只有「详情拉取」失败才置位 —— watch 本身失败是普通轮询抖动，不该报「画布同步失败」。
              // 恢复路径是下一次成功（`refreshDetail` 里复位），故这里只 sleep 后重来。
              if (stopped) return
              setDetailFailed(true)
              await new Promise((r) => setTimeout(r, 1500))
              continue
            }
            // ⚠️ 这里到 refreshTopics 之间还有一次 /api/me 往返：用户中途切走时若不复检 stopped，
            // 循环会带着「已不是当前任务」的旧 id 继续刷新 —— 那条结束会被当成后台任务再报一遍
            if (stopped) return
            if (fresh && fresh.topic.status === 'idle') {
              await refreshUser()
              if (stopped) return
              void refreshTopics()
            }
          }
        } catch (e) {
          if (stopped) return
          // 会话失效：终止轮询并明确告知（否则会一直重试同一个失效资源，用户只当是网络抖动）
          if (e instanceof ApiError && isSessionExpiredStatus(e.status)) {
            stopped = true
            setSessionExpired(true)
            return
          }
          await new Promise((r) => setTimeout(r, 1500))
        }
      }
    })()
    return () => {
      stopped = true
      ac.abort()
    }
  }, [activeId, sessionExpired, refreshDetail, refreshTopics])

  /**
   * 任务列表级监看：切到别的任务后，在跑的那个任务结束了也要有回执。
   *
   * 依赖是**布尔**而不是 `topics` 数组 —— 列表每次刷新不会重建定时器；空闲时**零请求**。
   * 取舍：本端全部空闲时不发请求，故别处（另一标签页）新启动的任务不会被发现，
   * 要等下一次列表刷新（提交 / 改名 / 删除 / 切任务）才可见。
   */
  const hasBusyTopic = topics.some((t) => isBusyStatus(t.status))
  useEffect(() => {
    // 会话已失效就不要再轮询：接口只会一直 401，白跑请求也刷不出新数据
    if (!hasBusyTopic || sessionExpired) return
    const timer = setInterval(() => {
      // 标签页在后台时不发请求：省掉没人看的轮询，回到前台的下一个 tick 自动追上
      if (typeof document !== 'undefined' && document.hidden) return
      void refreshTopics().catch((e) => {
        if (e instanceof ApiError && isSessionExpiredStatus(e.status)) setSessionExpired(true)
      })
    }, TOPIC_LIST_POLL_MS)
    return () => clearInterval(timer)
  }, [hasBusyTopic, sessionExpired, refreshTopics])

  const creatingRef = useRef(false)
  /** 确保存在活动任务：已有则直接复用 id；没有才向服务端创建/复用未使用任务（不动面板内容） */
  const ensureTopic = useCallback(async (): Promise<string | null> => {
    if (activeId) return activeId
    if (creatingRef.current) return null
    creatingRef.current = true
    try {
      const res = await fetch('/api/topics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '新任务' }),
      })
      const data = (await res.json()) as { topic?: Topic; reused?: boolean; error?: string }
      // 不检查 res.ok 的话，401 的 `{error}` 会被当成 `{topic: undefined}`，
      // 崩在 `topic.id` 上并报出一句看不懂的 TypeError（#83-1.6 的现象之一）
      if (!res.ok || !data.topic) throw new ApiError(res.status, data.error || '新任务创建失败，请重试')
      setActiveId(data.topic.id)
      await refreshTopics()
      if (data.reused) showToast({ tone: 'info', message: '已自动新建任务' })
      return data.topic.id
    } finally {
      creatingRef.current = false
    }
  }, [activeId, refreshTopics])

  /** 顶部浮动条 / 面板内的「＋ 新任务」：真正新建（或复用空闲空任务）并切换过去 */
  const createTopic = useCallback(
    async () => {
      setPanel(IDLE_PANEL)
      try {
        const res = await fetch('/api/topics', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: '新任务' }),
        })
        const data = (await res.json()) as { topic?: Topic; reused?: boolean; error?: string }
        if (!res.ok || !data.topic) throw new ApiError(res.status, data.error || '新任务创建失败，请重试')
        setActiveId(data.topic.id)
        await refreshTopics()
        showToast({ tone: 'success', message: data.reused ? '已回到未使用的空任务' : '已创建新任务' })
      } catch (e) {
        // 会话失效时给「登录已过期」而不是通用的「创建失败」——用户才知道该重新登录（#83-1.6）
        if (e instanceof ApiError && isSessionExpiredStatus(e.status)) {
          setSessionExpired(true)
          showToast({ tone: 'danger', message: '登录已过期，请重新登录' })
          return
        }
        // ⚠️ 只有 ApiError（本仓自己的错误类型，message 是服务端给的中文）才透传原文；
        // 离线时 fetch 直接 reject 出 `TypeError: Failed to fetch`（Safari 是 `Load failed`），
        // `instanceof Error` 会把英文原文弹成 toast，违反「UI 文案一律中文」。
        showToast({ tone: 'danger', message: e instanceof ApiError ? e.message : '新任务创建失败，请重试' })
      }
    },
    [refreshTopics]
  )

  const busy = isBusyStatus(detail?.topic.status)

  /**
   * 提交生成的**公共路径**：表单提交与「失败重试」都走它。
   *
   * 为什么抽出来：重试要用**失败那一轮**的参数提交，而那一刻 `panel` state 还没（也不该）同步过去 ——
   * 两条路径各写一份提交逻辑，等于把计费、暂存转正、回执这些容易出错的地方抄两遍。
   * 调用方传入完整参数，本函数只负责「提交 + 落地 + 报错」。
   *
   * ⚠️ `submittingRef` 防连击：提交是**扣费**动作，而「重试」比「生成」更容易被连点
   * （点了之后画面不会立刻变化，用户会以为没反应）。同一时刻只允许一次在途提交。
   */
  const submittingRef = useRef(false)
  const submitWith = useCallback(
    async (v: {
      prompt: string
      count: number
      /** 面板级尺寸：预设 key / 'auto' / 'custom' */
      size: string
      customW: number
      customH: number
      referenceIds: string[]
    }) => {
      // 提示词超限（>4000 字）在前端先行阻断：服务端也会 400，但用户不该等到提交才知道（#83-1.3）
      const promptErr = validatePrompt(v.prompt)
      if (promptErr) {
        showToast({ tone: 'danger', message: promptErr, timeoutMs: 4000 })
        return
      }
      if (submittingRef.current) return
      submittingRef.current = true
      try {
        // 保证在明确的活动任务下提交（没有则自动创建），避免依赖服务端对空 topicId 的隐式处理
        const tid = await ensureTopic()
        const sentRefIds = [...v.referenceIds]
        const res = await api.generate({
          prompt: v.prompt,
          count: v.count,
          size: v.size === 'custom' ? `${v.customW}x${v.customH}` : v.size,
          enhance: publicCfg?.llmEnhanceEnabled ?? false,
          topicId: tid,
          referenceCanvasImageIds: sentRefIds,
        } satisfies GenerateImagesInput)
        applyUser(res.user)
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
        // 会话失效：明确告知「登录已过期」，并把画布上的提示条也点亮（#83-1.6）
        if (e instanceof ApiError && isSessionExpiredStatus(e.status)) {
          setSessionExpired(true)
          showToast({ tone: 'danger', message: '登录已过期，请重新登录', timeoutMs: 4000 })
          return
        }
        const msg = e instanceof ApiError ? e.message : '提交失败，请重试。'
        showToast({ tone: 'danger', message: msg, timeoutMs: 4000 })
        // 额度不足：光提示不够，直接把充值入口送到用户面前
        if (msg.includes('额度不足')) {
          setDialog('billing')
        }
      } finally {
        submittingRef.current = false
      }
    },
    [ensureTopic, refreshTopics, refreshDetail, publicCfg?.llmEnhanceEnabled]
  )

  const submitGenerate = useCallback(
    () =>
      submitWith({
        prompt: panel.prompt,
        count: panel.count,
        size: panel.size,
        customW: panel.customW,
        customH: panel.customH,
        referenceIds: panel.referenceIds,
      }),
    [submitWith, panel]
  )

  /**
   * 待产出骨架槽（#88）：由「活跃轮次的槽位计划 − 已落库张数」推出，**一处计算两处用**：
   * ① 决定「一张图都没有时也要渲染画布」——否则首轮提交后骨架无处显示（原先只在有图时渲染）；
   * ② 传给 `CanvasStage` 渲染。
   *
   * 骨架不进 `canvasImages`，故不影响「N 张图片」计数、归档导出与整理布局（那些读的都是图片集合）。
   * 已落库张数按 `messageId` 统计 —— 服务端下发的槽位计划与出图共用同一坐标，
   * 故「第 k 张已落库」恰好对应「前 k 个槽已填、后面还空着」。
   */
  const skeletons = useMemo(() => {
    if (!detail) return []
    const generatedByMessage: Record<string, number> = {}
    for (const img of detail.canvasImages) {
      if (img.messageId) generatedByMessage[img.messageId] = (generatedByMessage[img.messageId] ?? 0) + 1
    }
    return pendingSkeletonSlots(detail.messages, generatedByMessage)
  }, [detail])

  /**
   * 失败轮次（当前活跃消息且已失败）。失败卡片进画布（#73-1.5）与重试入口共用这一个判据 ——
   * 两处各判一次，将来改一处就会出现「画布上有卡片、点重试却说没有可重试的轮次」。
   */
  const failedRound = useMemo(() => {
    if (!detail) return null
    const msg = activeMessage(detail)
    return msg && msg.status === 'failed' ? msg : null
  }, [detail])

  /**
   * 最近一次生成失败的信息（含退额说明）：持久展示在右侧面板上，直到下次提交。
   *
   * ⚠️ 必须由 `failedRound` 派生，**不要**再自己找一遍 `activeMessage`：两处各判一次，
   * 将来改一处就会出现「画布上有卡片、点重试却说没有可重试的轮次」（见上方 failedRound 的注释）。
   */
  const lastError = useMemo(
    () => (failedRound ? `上次生成失败：${failedRound.error ?? '未知原因'}` : null),
    [failedRound]
  )

  /**
   * 重试失败轮次：把该轮的提示词 / 张数 / 尺寸 / 参考图还原后**直接重新提交**。
   *
   * 为什么是「重试」而不是只预填：「以它为参考再生成」那条路径刻意只预填（CONTEXT 的 _Avoid_），
   * 而失败重试的诉求就是免掉「重新手动填写提交」这一步（issue #73-1.5 原文）。
   * 还原口径全在纯函数 `planRetryFromMessage` 里（可单测）。
   */
  const retryLastFailed = useCallback(() => {
    if (!detail || !failedRound) return
    const plan = planRetryFromMessage({
      message: failedRound,
      canvasImageIds: detail.canvasImages.map((i) => i.id),
    })
    // 先把表单还原成失败那轮的样子（用户看得到将要重跑什么），再用同一份参数提交
    setPanel((p) => ({
      ...p,
      prompt: plan.prompt,
      count: plan.count,
      size: plan.size,
      customW: plan.customW,
      customH: plan.customH,
      referenceIds: plan.referenceIds,
    }))
    void submitWith(plan)
  }, [detail, failedRound, submitWith])

  const cancelRunning = useCallback(async () => {
    if (!detail) return
    const msg = detail.messages.find((m) => m.id === detail.topic.activeMessageId)
    if (!msg) return
    try {
      await api.cancelMessage(msg.id)
      await refreshDetail(detail.topic.id)
      // 排队中的消息是**当场整单退额**，运行中的也会在 worker 收尾时退 ——
      // 不在这里刷一次，顶部余额会一直停在扣费后的读数（原先只靠 watch 的 idle 分支间接刷新，
      // 而任务一旦卡在 canceling 就永远等不到那次刷新）。
      // best-effort：取消本身已成功，余额刷新失败不该被报成「取消失败」。
      await refreshUser()
      showToast({ tone: 'info', message: '已请求取消任务，正在停止后台生成。' })
    } catch (e) {
      showToast({ tone: 'danger', message: e instanceof ApiError ? e.message : '取消失败' })
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
        showToast({ tone: 'info', message: '参考图已暂存，点「生成」后进入画布' })
      } catch (e) {
        showToast({ tone: 'danger', message: e instanceof ApiError ? e.message : '上传失败' })
      }
    },
    [ensureTopic, panel.referenceIds.length]
  )

  /**
   * 把提示词库的示例图带进表单：服务端抓取 → 落成暂存参考（`refu_`，不进画布）。
   * 与上传同口径：先看上限，再 `ensureTopic`（自动建任务），失败如实抛出交给弹窗内联显示。
   */
  const attachPromptImage = useCallback(
    async (entry: PromptLibraryEntry, index: number) => {
      if (panel.referenceIds.length >= MAX_REFERENCE_IMAGES) {
        throw new Error(`参考图最多 ${MAX_REFERENCE_IMAGES} 张，请先移除一张再添加`)
      }
      const tid = await ensureTopic()
      if (!tid) throw new Error('请先新建一个任务')
      const { reference } = await api.attachPromptImage({ topicId: tid, sourceId: entry.sourceId, entryId: entry.id, index })
      setPanel((p) => ({
        ...p,
        referenceIds: [...p.referenceIds, reference.id],
        staged: [...p.staged, reference],
        // 预览走**我们自己的字节**（服务端已经把图抓下来了），不复用远程 URL：
        // 否则第三方防盗链/签名过期时会变成破图，而浏览器也会多一个外部外联
        stagedPreviews: { ...p.stagedPreviews, [reference.id]: `/api/reference-uploads/${reference.id}` },
      }))
      showToast({
        tone: 'info',
        message: `已加入参考图（${panel.referenceIds.length + 1}/${MAX_REFERENCE_IMAGES}）；提示词未改动`,
      })
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

  /**
   * 面板展开态的初始化与宽度联动（2026-09-21 用户裁决）：
   * 宽屏默认展开、窄屏默认收起；**从宽变窄时自动收起**（否则两侧面板在窄屏会铺满画布并互相叠住）。
   * 用户的收起选择在宽度不变时一直保留 —— 拖窗口不会把用户手动收起的面板又弹开。
   */
  useEffect(() => {
    if (wide === null) return
    const next = (v: boolean | null) => (wide ? (v ?? true) : false)
    setLeftOpen(next)
    setRightOpen(next)
  }, [wide])

  /** 窄屏下两侧面板都是「铺满画布」的浮层，同时开会叠住 → 开一侧就关另一侧。
   * ⚠️ 联动必须写在更新器**外面**：setState 的更新器必须是纯函数（StrictMode 会双调用，
   * 队列 rebase 时还会在渲染期重算），在里面派发另一个 setState 无法保证「每个动作恰好执行一次」。 */
  const toggleLeft = useCallback(() => {
    const open = !leftOpen
    setLeftOpen(open)
    if (open && wide === false) setRightOpen(false)
  }, [leftOpen, wide])

  const toggleRight = useCallback(() => {
    const open = !rightOpen
    setRightOpen(open)
    if (open && wide === false) setLeftOpen(false)
  }, [rightOpen, wide])

  /**
   * 双击画布收起面板。
   *
   * 2026-09-21 用户裁决：
   * ① 右侧面板**不设收起按钮**，宽屏下收起入口只有这一个手势；而且必须是**双击**
   *    （单击留给画布自己的语义 —— 点空白取消选中、拖拽平移、Shift 框选；
   *    单击就收会把「点一下取消选中」变成「顺手把面板关了」）。
   * ② **窄屏两侧都是抽屉**，双击空白把当前打开的那个收回去（两侧行为一致）。
   *    窄屏的主路径其实是**单击遮罩**（见下面的 .ws-float-scrim），双击只是同一条兜底。
   * ③ 宽屏只收右侧 —— 左侧面板是常驻的任务列表，宽屏下它有自己的收起按钮，
   *    而且宽屏画布是主要工作区，双击顺手关掉任务列表会很烦。
   *
   * 豁免：图片卡片自己的双击是「放大预览」，工具栏/面板/弹层上的双击都不该顺手收起面板。
   */
  const onCanvasDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const t = e.target as HTMLElement
      if (t.closest('figure, [data-canvas-no-zoom], [role="dialog"], .ws-float-panel, .ws-collapsed-bar, .ws-nav')) return
      if (wide === false) {
        setLeftOpen(false)
        setRightOpen(false)
        return
      }
      if (rightOpen) setRightOpen(false)
    },
    [wide, rightOpen]
  )

  /**
   * 窄屏抽屉的键盘出口。
   * 去掉面板上的收起按钮后，鼠标路径是「双击空白」，键盘用户则完全没有了出口 ——
   * Esc 是抽屉的通用约定（也能覆盖遮罩挡住画布、只剩双击这一条鼠标路径的情况）。
   * 窄屏两侧都收（与双击一致）；宽屏不挂监听（那边面板是常驻的，Esc 不该有副作用）。
   */
  useEffect(() => {
    if (wide !== false || (leftOpen !== true && rightOpen !== true)) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setLeftOpen(false)
      setRightOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [wide, leftOpen, rightOpen])

  const logout = useCallback(async () => {
    await api.logout()
    // 清掉改密提醒的会话抑制标记：CONTEXT「会话抑制」把边界定在**一次登录**（重新登录可再次提示），
    // 而 sessionStorage 的天然边界是标签页 —— 靠这一步对齐。放在 await 之后：
    // 登出失败时用户还在登录态，此时清标记会让提醒在下一次重挂载时重新弹出来。
    clearHintDismissed(sessionStore(), user.id)
    router.refresh()
  }, [router, user.id])

  const onPaid = useCallback(
    // ⚠️ 文案必须用**本次到账额度**（#73-1.3）：`user.credits` 是充值后的总余额，
    // 拿它当「新充额度」会写出「已充值 153 张总额度中的新额度」这种既错又不通的句子。
    async (u: User, paidCredits: number) => {
      applyUser(u)
      setDialog(null)
      showToast({ tone: 'success', message: `支付成功，已到账 ${paidCredits} 张额度` })
    },
    []
  )

  return (
    <main className="ws-shell">
      {/* 导航头：**保持原样**（占位式顶栏），浮在画布上的是两侧面板而不是它。
          2026-09-21 二次裁决：顶栏左侧的「＋新任务」与任务名**已移除** —— 前者只在左侧面板与
          左上浮动条里，后者只在左侧面板头与左上浮动条里，顶栏不再重复。 */}
      <TopNav
        user={user}
        onOpenBilling={() => setDialog('billing')}
        onOpenProfile={() => setDialog('profile')}
        onLogout={() => void logout()}
      />

      {/* 改密入口即既有的个人资料弹窗（ProfileDialog 内含改密表单）。
          抑制标记（本次会话，`sessionStorage`）与两个出口都在 PasswordHintBanner 内部，
          这里只负责「账号是否被标记为需改密」这一个条件。 */}
      <PasswordHintBanner
        show={!!user?.mustChangePassword}
        userId={user?.id ?? ''}
        onChangePassword={() => setDialog('profile')}
      />

      {/* 画布区容器：双击收起生成面板（豁免见 onCanvasDoubleClick）。挂在容器上而不是遮罩上，
          是为了让宽屏（遮罩 display:none）也走同一条路径 —— 两档行为一致，不再分叉。 */}
      <section className="ws-canvas" onDoubleClick={onCanvasDoubleClick}>
        {/* 四态：等列表/等详情 → Spinner；详情拉取失败 → 失败态 + 重试；有图 → 画布；
            无图（含新手一个任务都没有）→ 新手引导。
            ⚠️ 失败态必须与空态分开：拉取失败时若复用空态引导就会**对有图的任务说「画布现在是空的」**
            （假陈述）。失败态只承诺两件事：不撒谎 + 给一个重试入口。
            重取失败时**同一任务**的旧 `detail` 会被保留（见上面 effect 里的说明），此时画布照常渲染、
            由下面的状态条栈给非阻断提示；只有「换了任务」才清空、落到本失败态。
            模板入口已收敛到右侧表单。 */}
        {!topicsLoaded || (activeId !== null && detail === null && !detailFailed) ? (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        ) : detail === null && detailFailed ? (
          <div className="flex h-full flex-col items-center justify-center gap-3">
            <Typography type="body-sm" style={{ color: 'var(--muted)' }}>画布加载失败，请检查网络后重试。</Typography>
            <Button
              variant="secondary"
              onPress={retryDetail}
            >
              重试
            </Button>
          </div>
        ) : detail && (detail.canvasImages.length > 0 || skeletons.length > 0) ? (
          <CanvasStage
            key={detail.topic.id}
            topicId={detail.topic.id}
            images={detail.canvasImages}
            messages={detail.messages}
            skeletons={skeletons}
            onRemoveImages={(imgs) => setConfirmDelete({ kind: 'image', ids: imgs })}
            onAddReferences={addReferencesFromCanvas}
            onRegenerate={regenerateFrom}
          />
        ) : failedRound && !busy ? null : (
          <CanvasEmptyGuide onOpenPromptLibrary={() => setDialog('promptLibrary')} />
        )}
        {/* 画布顶部的状态条**栈**：顶部居中，落在收起态浮动条（12..56）之下、两侧面板之间的中缝里。
            为什么是栈而不是两条各自绝对定位：它们会同时出现（生成中 + 详情同步失败），
            各自硬编码 `top` 就会互相盖住。顺序 = 「正在发生什么 → 出了什么问题」。
            z-index 26：高于两侧面板（25），真重叠时也点得到 —— 与 `.canvas-toolbar` 同一取舍；
            仍低于顶栏（30）。`pointer-events` 交给各条自己开（只有带按钮的那条需要）。 */}
        {sessionExpired || busy || (detail && detailFailed) ? (
          <div className="ws-canvas-notices">
            {/* 会话失效置顶：它是最该被看到、也唯一有明确出路的一条（重新登录） */}
            {sessionExpired ? (
              <div role="alert" className="ws-canvas-notice ws-canvas-notice-action" data-canvas-no-zoom>
                <InlineText type="body-sm" style={{ color: 'var(--muted-strong)' }}>
                  登录已过期，请重新登录后再继续。
                </InlineText>
                <Button size="sm" variant="secondary" onPress={() => window.location.assign('/')}>
                  重新登录
                </Button>
              </div>
            ) : null}
            {/* 生成进行中的全局提示：骨架已随首轮提交出现在画布上（#88），这条状态条
                补充「状态机在跑」这一层语义（含排队中尚无骨架可显示的短暂窗口）。 */}
            {busy ? (
              <div role="status" aria-live="polite" className="ws-canvas-notice" style={{ color: 'var(--foreground)' }}>
                <Spinner size="sm" />
                云端生成中，完成后图片会自动出现在画布
              </div>
            ) : null}
            {/* 后台重取失败但**保住了旧画布**（#85-1.2 的另一半）。
                ⚠️ 只在 `detail !== null` 时渲染：detail 被清空时走上面的失败态（也有「重试」），
                两处都渲染就会出现两个重试入口。
                `data-canvas-no-zoom` 让双击它不触发「收起生成面板」（该选择器已在豁免名单里）。 */}
            {detail && detailFailed ? (
              <div role="status" className="ws-canvas-notice ws-canvas-notice-action" data-canvas-no-zoom>
                <InlineText type="body-sm" style={{ color: 'var(--muted-strong)' }}>
                  画布同步失败，显示的是上次加载的内容。
                </InlineText>
                <Button size="sm" variant="secondary" onPress={retryDetail}>
                  重试
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
        {/* 失败卡片进画布（#73-1.5）。
            原先失败只在右侧面板留一条横幅 —— 用户的第一视线在画布上，画布却什么都没有；
            空任务失败时还会落进新手引导说「画布现在是空的」（对一个刚失败的任务是假陈述）。
            卡片画在**画布区**（`section.ws-canvas` 的绝对定位子元素）而不是 CanvasStage 内部：
            它不属于画布坐标系（不随平移/缩放移动、不可选中/拖动、不参与归档与整理），
            且 `CanvasStage` 只在有图时渲染 —— 失败轮次往往一张图都没有，放进去就永远看不到。
            `data-canvas-no-zoom` 让双击卡片不触发「收起生成面板」（该选择器已在豁免名单里）。

            ⚠️ 空任务失败时**不再渲染新手引导**（上面画布分支里的 `failedRound && !busy ? null`）：
            卡片会盖在引导正中间，引导那句「画布现在是空的」对刚失败的任务是假陈述，
            两个一起显示只会让人以为「任务没发生过」。引导让位给卡片，卡片自己就是这条路径的出口。

            ⚠️ 层级是 **z-24**（= 窄屏遮罩），不是 26：窄屏抽屉（面板/浮动条 z-25）打开时，
            卡片恰好落在抽屉区域内（700px 高视口下卡片 y≈270–430，抽屉覆盖 y≈142–688）——
            若卡片压过抽屉，那块区域就成了死区，抽屉里的按钮点不到。z-24 让卡片在宽屏下
            落在两侧面板（25）之下（卡片居中、面板在两侧，本就不重叠），窄屏下被遮罩压暗即可。
            配套：容器 `pointer-events-none`（整张卡片不该吃掉画布手势），只有「重试」按钮开回 `auto`。 */}
        {failedRound && !busy ? (
          <div
            // ⚠️ 刻意**不用** role="alert"：同一次失败在右侧面板的横幅上已经是一个 live region，
            // 两处都声明就会把同一句话播报两遍。这里的角色是「画布上的可见卡片 + 重试入口」，
            // 播报由横幅负责（见 TaskPanel 的失败 Alert）。
            data-canvas-no-zoom
            className="pointer-events-none absolute left-1/2 top-1/2 z-[24] w-[min(360px,calc(100%-48px))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border p-4 shadow-lg"
            style={{ borderColor: 'var(--border)', background: 'var(--surface-primary)' }}
          >
            <InlineText type="body-sm" className="block font-semibold" style={{ color: 'var(--danger-quiet)' }}>
              生成失败
            </InlineText>
            <InlineText type="body-sm" className="mt-1 block" style={{ color: 'var(--muted-strong)' }}>
              {failedRound.error ?? '未知原因'}
            </InlineText>
            <InlineText type="body-xs" className="mt-1 block" style={{ color: 'var(--muted)' }}>
              本轮请求 {failedRound.requestedCount} 张，未产出的额度已退回。
            </InlineText>
            <Button size="sm" variant="primary" className="pointer-events-auto mt-3" onPress={() => retryLastFailed()}>
              重试
            </Button>
          </div>
        ) : null}
        {/* 两侧浮动面板 / 收起后的浮动条：都在**画布区内**绝对定位（顶栏仍是占位的，面板从它下面开始）。
            2026-09-21 用户裁决：面板展开时占据该侧位置；**收起后原位换成一条小浮动条**，
            里面放该侧的关键动作 —— 左：展开按钮 + 任务名 + 新建任务；右：展开按钮 + 生成/取消 + 张数尺寸摘要。
            这样收起面板也不会丢掉「切任务」与「一键生成」这两个主路径。 */}

        {/* 窄屏遮罩：宽屏下 display:none ⇒ 既不显示也不参与命中测试。
            2026-09-21 用户裁决：**两侧抽屉都要有这层背景**（变暗 + 挡住画布交互），
            所以任一侧展开就渲染；**点它就收起抽屉**（2026-09-21 用户裁决）——
            窄屏下遮罩铺满画布，点空白即收起是抽屉的通用约定；
            宽屏没有遮罩，收起走画布的**双击**（见 onCanvasDoubleClick）。
            它是纯背景，所以 aria-hidden + 不进 Tab 序；键盘出口是 Esc。
            放在面板**之前**：z-index 更低（24 < 25），点面板仍可交互 */}
        {leftOpen || rightOpen ? (
          <div
            className="ws-float-scrim"
            aria-hidden="true"
            onClick={() => {
              setLeftOpen(false)
              setRightOpen(false)
            }}
          />
        ) : null}

        {/* ⚠️ `leftOpen === null` = 还不知道屏幕多宽（SSR / hydration 首帧）→ **两边都不渲染**。
            若把它当 false 处理，宽屏首帧会先冒出一条「已收起」的浮动条再被面板替换（闪错态）。 */}
        {leftOpen === null ? null : leftOpen ? (
          <aside className="ws-float-panel ws-float-left" aria-label="任务面板">
            <TopicPanel
              topics={topics}
              activeId={activeId}
              activeTitle={detail?.topic.title ?? '新任务'}
              onSelect={(id) => setActiveId(id)}
              onRename={(id, t) => void renameTopic(id, t)}
              onDelete={(id) => {
                const t = topics.find((x) => x.id === id)
                setConfirmDelete({ kind: 'topic', id, title: t?.title ?? '该任务' })
              }}
              onNewTask={() => void createTopic()}
              onCollapse={toggleLeft}
              onInvite={() => setDialog('invite')}
              onFeedback={() => setDialog('feedback')}
            />
          </aside>
        ) : (
          <div className="ws-collapsed-bar ws-collapsed-left">
            <IconButton variant="secondary" label="展开任务面板" onPress={toggleLeft}>
              <LayoutSideContentLeft />
            </IconButton>
            {/* 任务名只在 ≥lg 显示：窄屏两条浮动条会挤在一起（见 globals.css 的说明） */}
            <InlineText style={{ color: 'var(--muted-strong)' }} type="body-sm"
              className="hidden min-w-0 truncate lg:inline"
              title={detail?.topic.title ?? '新任务'}
            >
              {detail?.topic.title ?? '新任务'}
            </InlineText>
            <IconButton variant="secondary" label="新建任务" onPress={() => void createTopic()}>
              <Plus />
            </IconButton>
          </div>
        )}

        {rightOpen === null ? null : rightOpen ? (
          <aside className="ws-float-panel ws-float-right" aria-label="生成面板">
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
              onOpenPromptLibrary={() => setDialog('promptLibrary')}
              onGenerate={() => void submitGenerate()}
              onCancel={() => void cancelRunning()}
              onNewTask={() => void createTopic()}
              onRetryLast={() => retryLastFailed()}
            />
          </aside>
        ) : (
          <div className="ws-collapsed-bar ws-collapsed-right">
            <IconButton variant="secondary" label="展开生成面板" onPress={toggleRight}>
              <LayoutSideContentRight />
            </IconButton>
            {busy ? (
              <Button variant="secondary" onPress={() => void cancelRunning()}>取消生成</Button>
            ) : (
              <Button variant="primary" onPress={() => void submitGenerate()} isDisabled={!panel.prompt.trim()}>
                {panel.prompt.trim() ? `生成（${panel.count} 张）` : '生成'}
              </Button>
            )}
            {/* 摘要只在 ≥md 显示：窄屏放不下（同左条的任务名） */}
            <InlineText style={{ color: 'var(--muted)' }} type="body-xs" className="hidden whitespace-nowrap md:inline">
              {panel.count} 张 · {sizeLabelOf(panel.size)}
            </InlineText>
          </div>
        )}
      </section>

      {dialog === 'promptLibrary' && (
        <PromptLibraryModal
          onClose={() => setDialog(null)}
          referenceCount={panel.referenceIds.length}
          maxReferences={MAX_REFERENCE_IMAGES}
          onAttachImage={attachPromptImage}
          onCopyPrompt={(entry) => {
            void navigator.clipboard?.writeText(entry.prompt)
            showToast({ tone: 'info', message: '提示词已复制' })
          }}
          onSelect={(prompt) => {
            // 与「以它为参考再生成」同一口径：直接覆盖面板内容，并在 toast 里说清覆盖了什么
            const had = panel.prompt.trim().length > 0
            setPanel((p) => ({ ...p, prompt }))
            setDialog(null)
            showToast({ tone: 'info', message: had ? '已填入提示词（原有内容已覆盖）' : '已填入提示词' })
          }}
        />
      )}
      {dialog === 'billing' && (
        <BillingDialog
          onClose={() => setDialog(null)}
          onPaid={(u, paid) => void onPaid(u, paid)}
          onRedeem={() => setDialog('redeem')}
        />
      )}
      {dialog === 'redeem' && (
        <RedeemDialog
          onClose={() => setDialog(null)}
          onRedeemed={(u) => {
            applyUser(u)
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
            applyUser(u)
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
                  <Typography type="body-sm" style={{ color: 'var(--muted)', lineHeight: 1.8 }}>
                    {deleteImageConfirmText(confirmDelete.ids.length)}
                    <br />
                    其余图片的编号保持不变，提示词里已写好的编号仍会指向原来的图片。
                  </Typography>
                ) : (
                  <Typography type="body-sm" style={{ color: 'var(--muted)', lineHeight: 1.8 }}>
                    将删除任务「{confirmDelete.title}」及其全部生成记录与图片，删除后无法恢复。
                  </Typography>
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
