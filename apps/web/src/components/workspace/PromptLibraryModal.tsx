'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Chip, SearchField, Skeleton, Spinner, Tag, TagGroup, Typography } from '@heroui/react'
import { InlineText } from '@/components/ui/typography'
import { ArrowRotateRight } from '@gravity-ui/icons'
import { api, type PromptLibraryEntry } from '@/lib/client'
import { errorMessage } from '@/lib/error-message'
import { PromptDetailDialog } from './PromptDetailDialog'
import { ALL_PROMPTS_OPTION, PROMPT_PAGE_SIZE } from '@/lib/prompt-sources'
import { WorkspaceModal } from './dialogs'

/** 搜索防抖：连打字符只发一次请求（与上游一致 300ms） */
const SEARCH_DEBOUNCE_MS = 300
/** 滚动到底多少像素内自动取下一页（与上游一致 160px） */
const LOAD_MORE_THRESHOLD_PX = 160
/**
 * 只要服务端还有陈旧的可抓取源在后台抓，响应里就是 `pending: true`。
 * 前端每 2 秒重取一次、最多 5 次（≈10 秒），之后停止轮询 —— 停止轮询不等于死路：
 * 失败源 5 分钟后会自动重抓，管理员也可在系统设置里「立即刷新」。
 */
const PENDING_POLL_MS = 2000
const PENDING_MAX_POLLS = 5

interface PromptSourceFacet {
  id: string
  name: string
  homepage: string
  entryCount: number
}

interface Props {
  onClose: () => void
  /** 选中一条：把它的正文填进提示词框（由父级决定覆盖与提示文案） */
  onSelect: (prompt: string) => void
  /** 当前参考图总数（暂存 + 画布引用），用于详情弹窗的上限提示 */
  referenceCount: number
  maxReferences: number
  /** 把某条提示词的第 index 张示例图带进表单（父级负责调接口、落面板与回执） */
  onAttachImage: (entry: PromptLibraryEntry, index: number) => Promise<void>
  onCopyPrompt: (entry: PromptLibraryEntry) => void
}

/**
 * 一条提示词卡片：封面 + 标题 + 正文摘要 + 标签；点整卡即选中。署名统一在 NOTICE，卡片不再露出上游地址与来源名。
 *
 * 封面区**始终垫一层骨架**，图片 load 后才撤掉（#73-1.8）。
 * 为什么：封面是远程图 + `loading="lazy"`，滚动加载出来的新卡片在图片到达前，封面区就是一块
 * 没有任何占位动画的空白浅框（首屏有 `EntryGridSkeleton` 兜着，所以只有滚动加载时看着突兀）。
 * 骨架与 `<img>` 同处一个 `relative` 容器、`aspect-square` 撑高 ⇒ 图片到达时不会跳位。
 */
function EntryCard({
  entry,
  coverBroken,
  onBrokenCover,
  onSelect,
  onOpenDetail,
}: {
  entry: PromptLibraryEntry
  coverBroken: boolean
  onBrokenCover: (key: string) => void
  onSelect: () => void
  /** 有示例图时才有这个入口：卡片主体仍是「填提示词」，看大图/带参考图走次级按钮 */
  onOpenDetail: (() => void) | null
}) {
  const key = `${entry.sourceId}:${entry.id}`
  /** 封面字节是否已就位（load 或 error 都算「不再需要骨架」） */
  const [coverLoaded, setCoverLoaded] = useState(false)
  const hasCover = Boolean(entry.coverUrl) && !coverBroken
  return (
    <div
      className="flex flex-col overflow-hidden rounded-lg border"
      style={{ borderColor: 'var(--border)', background: 'var(--surface-primary)' }}
    >
      <button type="button" onClick={onSelect} aria-label={`选用提示词：${entry.title}`} className="block w-full text-start">
        <span className="relative block w-full">
          {hasCover && !coverLoaded && <Skeleton className="absolute inset-0 rounded-none" />}
          {hasCover ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={entry.coverUrl}
              alt={entry.title}
              loading="lazy"
              // 未就位时先透明：底下的骨架才是这一格的视觉，图片到了再显出来（不会闪白框）
              style={{ opacity: coverLoaded ? 1 : 0 }}
              className="aspect-square w-full object-cover"
              onLoad={() => setCoverLoaded(true)}
              onError={() => {
                onBrokenCover(key)
                setCoverLoaded(true)
              }}
            />
          ) : (
            <span
              aria-hidden
              className="flex aspect-square w-full items-center justify-center text-xs"
              style={{ color: 'var(--muted)', background: 'var(--canvas-background)' }}
            >
              无预览图
            </span>
          )}
        </span>
        <InlineText type="body-sm" className="block px-3 pt-2">
          <InlineText type="body-sm" className="line-clamp-1 block font-medium">{entry.title}</InlineText>
          <InlineText type="body-xs" className="mt-1 line-clamp-3 block leading-5" style={{ color: 'var(--muted)' }}>
            {entry.description || entry.prompt}
          </InlineText>
        </InlineText>
      </button>
      <div className="mt-auto flex flex-wrap items-center gap-1.5 px-3 pb-3 pt-2">
        {onOpenDetail && (
          <Button variant="secondary" size="sm" className="text-[11px]" aria-label={`查看示例图：${entry.title}`} onPress={onOpenDetail}>
            示例图{entry.images.length > 0 ? `（${entry.images.length}）` : ''}
          </Button>
        )}
        {entry.tags.slice(0, 3).map((t) => (
          <Chip key={t} className="text-[10px]">
            {t}
          </Chip>
        ))}
      </div>
    </div>
  )
}

/**
 * 提示词库的骨架卡片：**与真实卡片同形**，尺寸逐项对齐 `EntryCard`，避免「骨架 → 内容」二次跳动。
 *
 * 对齐依据（照 `EntryCard` 量）：
 * - 封面 `aspect-square w-full`
 * - 标题 `text-sm`（行高 20px）→ `h-5`；描述 **`line-clamp-3`（最多三行）**，`leading-5` → 三条 `h-3` + `mt-1.5`
 * - 底部行是 `Button size="sm"`（高 32px）与 `Chip` → `h-8` / `h-6`
 *
 * ⚠️ 描述画几行必须跟着 `line-clamp-N` 走：少画一行，内容到达时列表高度就会跳一次。
 */
function EntryCardSkeleton() {
  return (
    <div
      className="flex flex-col overflow-hidden rounded-lg border"
      style={{ borderColor: 'var(--border)', background: 'var(--surface-primary)' }}
    >
      <Skeleton className="aspect-square w-full rounded-none" />
      <div className="block px-3 pt-2">
        <Skeleton className="h-5 w-4/5 rounded-medium" />
        <Skeleton className="mt-1.5 h-3 w-full rounded-medium" />
        <Skeleton className="mt-1.5 h-3 w-full rounded-medium" />
        <Skeleton className="mt-1.5 h-3 w-2/3 rounded-medium" />
      </div>
      <div className="mt-auto flex items-center gap-1.5 px-3 pb-3 pt-2">
        <Skeleton className="h-8 w-20 rounded-full" />
        <Skeleton className="h-6 w-12 rounded-full" />
      </div>
    </div>
  )
}

/**
 * 网格骨架：列数与真实网格一致（`sm:grid-cols-2 lg:grid-cols-3`）。
 *
 * ⚠️ `w-full` 不能省：本组件会被放进 `flex flex-col items-center` 的容器里，成为 **flex item** ——
 * 不加 `w-full` 就按 fit-content 收缩；而网格列是 `minmax(0,1fr)`、骨架宽又是百分比，
 * 在不确定宽度下会解析成 0 → **整个骨架塌成一条缝、看不见**（实测过）。
 */
function EntryGridSkeleton({ count = 6, className = '' }: { count?: number; className?: string }) {
  return (
    <div className={`grid w-full gap-3 sm:grid-cols-2 lg:grid-cols-3 ${className}`} aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <EntryCardSkeleton key={i} />
      ))}
    </div>
  )
}

/**
 * 提示词库弹窗：左筛选栏（来源 + 标签）+ 搜索框 + 卡片网格 + 滚动加载。
 *
 * 数据全部来自本仓服务端（`GET /api/prompts`）—— 上游那 5 个提示词仓库是**服务端**抓的，
 * 浏览器不直连外部 API（唯一外联是卡片封面图片，加载失败会降级成占位）。
 */
function PromptLibraryModal({ onClose, onSelect, referenceCount, maxReferences, onAttachImage, onCopyPrompt }: Props) {
  const [keyword, setKeyword] = useState('')
  const [debouncedKeyword, setDebouncedKeyword] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [source, setSource] = useState(ALL_PROMPTS_OPTION)
  const [items, setItems] = useState<PromptLibraryEntry[]>([])
  const [facetTags, setFacetTags] = useState<string[]>([])
  const [facetSources, setFacetSources] = useState<PromptSourceFacet[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [pending, setPending] = useState(false)
  // 轮询预算用尽后不再对外声称「还在加载」：源抓取失败会让 `pending` 一直为真，
  // 不额外收口的话底部提示与空态骨架都会永久驻留（转圈永远转不完）
  const [pollExhausted, setPollExhausted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [brokenCovers, setBrokenCovers] = useState<string[]>([])
  const [detailEntry, setDetailEntry] = useState<PromptLibraryEntry | null>(null)

  // 迟到的旧响应不许落地：连打搜索词时后发的请求可能先回
  const seqRef = useRef(0)

  const load = useCallback(
    async (targetPage: number, mode: 'replace' | 'append') => {
      const seq = ++seqRef.current
      if (mode === 'replace') setLoading(true)
      else setLoadingMore(true)
      try {
        const r = await api.listPrompts({ q: debouncedKeyword, tags, source, page: targetPage, pageSize: PROMPT_PAGE_SIZE })
        if (seq !== seqRef.current) return
        setItems((prev) => {
          if (mode === 'replace') return r.items
          // 翻页时按「源 + 条目 id」去重：抓取恰好发生在翻页之间会让同一批条目出现在两页里
          const seen = new Set(prev.map((i) => `${i.sourceId}:${i.id}`))
          return [...prev, ...r.items.filter((i) => !seen.has(`${i.sourceId}:${i.id}`))]
        })
        setTotal(r.total)
        setFacetTags(r.tags)
        setFacetSources(r.sources)
        setPending(r.pending)
        setPage(targetPage)
        setError(null)
      } catch (e) {
        if (seq === seqRef.current) setError(errorMessage(e, '提示词库加载失败'))
      } finally {
        if (seq === seqRef.current) {
          setLoading(false)
          setLoadingMore(false)
        }
      }
    },
    [debouncedKeyword, tags, source]
  )

  const loadRef = useRef(load)
  useEffect(() => {
    loadRef.current = load
  }, [load])

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedKeyword(keyword), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [keyword])

  // 筛选条件变化（含防抖后的关键词）⇒ 回第 1 页重取
  useEffect(() => {
    void load(1, 'replace')
  }, [load])

  // 首次抓取进行中：每 2 秒重取一次，最多 5 次（用 ref 调最新 load，避免闭包取到旧筛选条件）
  // ⚠️ 预算用尽必须**同时**收掉指示（置 `pollExhausted`）—— 服务端的 `pending` 只看「还有陈旧源」，
  // 源一直抓不到时它不会自己变假，光停轮询会留下一个永不消失的「正在加载提示词…」。
  useEffect(() => {
    if (!pending) return
    setPollExhausted(false)
    let polls = 0
    const timer = setInterval(() => {
      polls += 1
      if (polls > PENDING_MAX_POLLS) {
        clearInterval(timer)
        setPollExhausted(true)
        return
      }
      void loadRef.current(1, 'replace')
    }, PENDING_POLL_MS)
    return () => clearInterval(timer)
  }, [pending])

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    if (loadingMore || loading) return
    if (items.length >= total) return
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - LOAD_MORE_THRESHOLD_PX) {
      void load(page + 1, 'append')
    }
  }

  const hasFilter = Boolean(debouncedKeyword) || tags.length > 0 || source !== ALL_PROMPTS_OPTION
  /** 「还有源在后台抓」且**轮询预算没用完**才算加载中 —— 预算用尽后 `pending` 可能仍为真（死源），
   *  但那时不该再让用户等：列表非空就照常看内容，列表为空就如实说「还没有内容」。 */
  const showPending = pending && !pollExhausted
  /**
   * 内容为空时区分成因（按优先级判）：
   * 1. 还有源正在后台抓（`showPending`）⇒ 加载态，不能显示成「拉不到」
   * 2. 抓完了、只是当前筛选没命中 / 库里确实没内容
   *
   * ⚠️ 这里**不再有**「抓取失败」这一类：上游源的抓取失败是运维信息，不进用户面 ——
   * 失败时用户就是「看到上次成功的内容」或「还没有内容」，与正常情况无差别。
   * 注意「系统自带」是本地播种的源，所以**列表几乎不会真的为空**；`showPending` 为真时
   * 内容区照常显示已有条目，只在底部计数行提示「正在加载提示词…」，并继续轮询。
   */
  const emptyKind: 'fetching' | 'filtered' | 'empty' = showPending ? 'fetching' : hasFilter ? 'filtered' : 'empty'

  return (
    <WorkspaceModal title="提示词库" onClose={onClose} dialogClassName="max-w-[min(960px,94vw)]">
      <div className="grid h-[62dvh] min-h-0 gap-4 sm:grid-cols-[170px_minmax(0,1fr)]">
        <aside className="min-h-0 overflow-y-auto pe-1">
          <div className="ws-panel-label mb-1.5">来源</div>
          <TagGroup
            selectionMode="single"
            selectedKeys={new Set([source])}
            onSelectionChange={(keys) => {
              const k = [...keys][0]
              setSource(k ? String(k) : ALL_PROMPTS_OPTION)
            }}
          >
            <TagGroup.List>
              <Tag id={ALL_PROMPTS_OPTION}>全部</Tag>
              {facetSources.map((s) => (
                <Tag key={s.id} id={s.name}>
                  {s.name}
                </Tag>
              ))}
            </TagGroup.List>
          </TagGroup>

          <div className="ws-panel-label mb-1.5 mt-4">标签</div>
          {facetTags.length === 0 ? (
            <Typography type="body-xs" style={{ color: 'var(--muted)' }}>
              暂无标签
            </Typography>
          ) : (
            <TagGroup
              selectionMode="multiple"
              selectedKeys={new Set(tags)}
              onSelectionChange={(keys) => setTags([...keys].map(String))}
            >
              <TagGroup.List>
                {facetTags.map((t) => (
                  <Tag key={t} id={t}>
                    {t}
                  </Tag>
                ))}
              </TagGroup.List>
            </TagGroup>
          )}
        </aside>

        <section className="flex min-h-0 min-w-0 flex-col">
          <SearchField aria-label="搜索提示词" value={keyword} onChange={setKeyword}>
            <SearchField.Group>
              <SearchField.SearchIcon />
              <SearchField.Input placeholder="搜索标题、提示词或标签…" className="w-full" />
              <SearchField.ClearButton />
            </SearchField.Group>
          </SearchField>

          <div onScroll={onScroll} className="mt-3 min-h-0 flex-1 overflow-y-auto pe-1">
            {loading && items.length === 0 ? (
              /* **首屏**才用骨架：内容是形状可预判的卡片网格，骨架比转圈更贴近最终形态。
                 ⚠️ 不能写成 `loading ?`：上游还在抓时每 2s 轮询一次 `load(1,'replace')` 会把 loading 置回 true，
                 那样**已经渲染出来的卡片会被整块换成骨架、再换回来**（图片重挂 + 高度抖动），与「避免跳动」正相反。 */
              <EntryGridSkeleton />
            ) : error ? (
              <div className="flex h-40 flex-col items-center justify-center gap-2 text-sm" style={{ color: 'var(--muted)' }}>
                <InlineText color="muted" type="body-sm">{error}</InlineText>
                <Button variant="secondary" size="sm" onPress={() => void load(1, 'replace')}>
                  <ArrowRotateRight />
                  重试
                </Button>
              </div>
            ) : items.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 px-4 py-6 text-center text-sm" style={{ color: 'var(--muted)' }}>
                {/* ⚠️ 下面这些 `align="center"` 不能省：本容器靠 `text-center` 居中，而 `Typography` 自己在
                    元素上带 `text-align: start`。单行时看不出差别（子元素按 fit-content 居中），
                    一旦折行第二行起就是左对齐。 */}
                {emptyKind === 'fetching' ? (
                  <>
                    {/* 上游还在抓：内容形状同样可预判（卡片网格）。⚠️ 这里不能限高（原来的 h-40 装不下三张卡），
                        也不能让 grid 按 fit-content 收缩 —— 否则骨架塌成一条缝（见 EntryGridSkeleton 的说明）。 */}
                    <EntryGridSkeleton count={3} />
                    <InlineText color="muted" type="body-sm" align="center">正在加载提示词…</InlineText>
                  </>
                ) : emptyKind === 'filtered' ? (
                  <InlineText color="muted" type="body-sm" align="center">没有匹配的提示词，换个关键词或标签试试</InlineText>
                ) : (
                  <InlineText color="muted" type="body-sm" align="center">提示词库还没有内容</InlineText>
                )}
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {items.map((entry) => (
                  <EntryCard
                    key={`${entry.sourceId}:${entry.id}`}
                    entry={entry}
                    coverBroken={brokenCovers.includes(`${entry.sourceId}:${entry.id}`)}
                    onBrokenCover={(k) => setBrokenCovers((prev) => (prev.includes(k) ? prev : [...prev, k]))}
                    onSelect={() => onSelect(entry.prompt)}
                    onOpenDetail={entry.images.length > 0 ? () => setDetailEntry(entry) : null}
                  />
                ))}
              </div>
            )}
          </div>

          <div className="mt-2 flex items-center justify-between text-xs" style={{ color: 'var(--muted)' }}>
            <div>
              {/* 首屏加载中不显示「共 0 条」：与「真的没有数据」无法区分（同 ListUi 的口径） */}
              {loading ? (
                <Skeleton className="inline-block h-3.5 w-14 rounded-medium" />
              ) : (
                <>
                  <InlineText color="muted" type="body-xs">{loadingMore ? '正在加载更多…' : `共 ${total} 条`}</InlineText>
                  {showPending && <InlineText color="muted" type="body-xs" className="ms-2">（正在加载提示词…）</InlineText>}
                </>
              )}
            </div>
            {loadingMore && <Spinner size="sm" />}
          </div>
        </section>
      </div>


      {detailEntry && (
        <PromptDetailDialog
          entry={detailEntry}
          referenceCount={referenceCount}
          maxReferences={maxReferences}
          onClose={() => setDetailEntry(null)}
          onAttachImage={(index) => onAttachImage(detailEntry, index)}
          onCopyPrompt={() => onCopyPrompt(detailEntry)}
        />
      )}
    </WorkspaceModal>
  )
}

export { PromptLibraryModal }
