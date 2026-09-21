'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Button, Chip, SearchField, Spinner, Tag, TagGroup } from '@heroui/react'
import { ArrowRotateRight } from '@gravity-ui/icons'
import { IconButton } from '@/components/ui/icon-button'
import { api, type PromptLibraryEntry } from '@/lib/client'
import { showToast } from '@/components/ui/toast'
import { PromptDetailDialog } from './PromptDetailDialog'
import { ALL_PROMPTS_OPTION, PROMPT_PAGE_SIZE } from '@/lib/prompt-sources'
import { WorkspaceModal } from './dialogs'

/** 搜索防抖：连打字符只发一次请求（与上游一致 300ms） */
const SEARCH_DEBOUNCE_MS = 300
/** 滚动到底多少像素内自动取下一页（与上游一致 160px） */
const LOAD_MORE_THRESHOLD_PX = 160
/**
 * 只要服务端还有陈旧的可抓取源在后台抓，响应里就是 `pending: true`。
 * 前端每 2 秒重取一次、最多 5 次（≈10 秒，覆盖服务端 8 秒的单源上限），之后停止轮询。
 * 停止轮询不等于死路：抓取失败的源会连同原因一起显示在告警区，那里有「重试」按钮
 * （走 `POST /api/prompts/retry`，服务端绕过 5 分钟的失败节奏）。
 */
const PENDING_POLL_MS = 2000
const PENDING_MAX_POLLS = 5

interface PromptSourceFacet {
  id: string
  name: string
  homepage: string
  entryCount: number
}

interface PromptFailure {
  sourceId: string
  sourceName: string
  error: string
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

/** 一条提示词卡片：封面 + 标题 + 正文摘要 + 标签 + 来源外链；点整卡即选中 */
function EntryCard({
  entry,
  sourceHomepage,
  coverBroken,
  onBrokenCover,
  onSelect,
  onOpenDetail,
}: {
  entry: PromptLibraryEntry
  /** 该条目所属源的仓库地址：条目自身没有出处链接时回退到它（照抄上游 `item.sourceUrl || source.homepage`） */
  sourceHomepage: string
  coverBroken: boolean
  onBrokenCover: (key: string) => void
  onSelect: () => void
  /** 有示例图时才有这个入口：卡片主体仍是「填提示词」，看大图/带参考图走次级按钮 */
  onOpenDetail: (() => void) | null
}) {
  const key = `${entry.sourceId}:${entry.id}`
  const origin = entry.sourceUrl || sourceHomepage
  return (
    <div
      className="flex flex-col overflow-hidden rounded-lg border"
      style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
    >
      <button type="button" onClick={onSelect} aria-label={`选用提示词：${entry.title}`} className="block w-full text-start">
        {entry.coverUrl && !coverBroken ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={entry.coverUrl}
            alt={entry.title}
            loading="lazy"
            className="aspect-square w-full object-cover"
            onError={() => onBrokenCover(key)}
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
        <span className="block px-3 pt-2">
          <span className="line-clamp-1 block text-sm font-medium">{entry.title}</span>
          <span className="mt-1 line-clamp-3 block text-xs leading-5" style={{ color: 'var(--muted)' }}>
            {entry.description || entry.prompt}
          </span>
        </span>
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
        {/* 出处：内容来自上游开源仓库，按署名要求给到原仓库链接（浏览器唯一的「外链」，不发起 API 调用） */}
        {origin ? (
          <a
            href={origin}
            target="_blank"
            rel="noreferrer noopener"
            className="ms-auto text-[11px] underline"
            style={{ color: 'var(--muted)' }}
          >
            {entry.sourceName}
          </a>
        ) : (
          <span className="ms-auto text-[11px]" style={{ color: 'var(--muted)' }}>
            {entry.sourceName}
          </span>
        )}
      </div>
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
  const [failures, setFailures] = useState<PromptFailure[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [brokenCovers, setBrokenCovers] = useState<string[]>([])
  const [retrying, setRetrying] = useState(false)
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
        setFailures(r.failures)
        setPending(r.pending)
        setPage(targetPage)
        setError(null)
      } catch (e) {
        if (seq === seqRef.current) setError(e instanceof Error ? e.message : '提示词库加载失败')
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

  /**
   * 重试：抓取失败时用户自己重来一次。
   * 走 POST /api/prompts/retry —— 服务端**绕过失败重试节奏**，否则点下去 5 分钟内什么都不会发生。
   */
  const retry = useCallback(async () => {
    setRetrying(true)
    setError(null)
    // 重试自己接管 loading：在途的那次 load 会被下面的 seq 推进作废，
    // 它的 finally 不再复位 loading（否则「作废」和「不复位」叠加会把内容区永久钉在 Spinner 上）
    setLoading(true)
    setLoadingMore(false)
    const seq = ++seqRef.current // 丢弃在途的旧响应
    try {
      const r = await api.retryPrompts({ q: debouncedKeyword, tags, source, page: 1, pageSize: PROMPT_PAGE_SIZE })
      if (seq !== seqRef.current) return
      setItems(r.items)
      setTotal(r.total)
      setFacetTags(r.tags)
      setFacetSources(r.sources)
      setFailures(r.failures)
      setPending(r.pending)
      setPage(1)
      showToast(
        r.failures.length === 0
          ? { tone: 'success', message: `重试成功，共 ${r.total} 条` }
          : { tone: 'warning', message: `重试了 ${r.retried} 个源，仍有 ${r.failures.length} 个源失败` }
      )
    } catch (e) {
      if (seq === seqRef.current) setError(e instanceof Error ? e.message : '重试失败')
    } finally {
      if (seq === seqRef.current) {
        setLoading(false)
        setLoadingMore(false)
      }
      setRetrying(false)
    }
  }, [debouncedKeyword, tags, source])

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedKeyword(keyword), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [keyword])

  // 筛选条件变化（含防抖后的关键词）⇒ 回第 1 页重取
  useEffect(() => {
    void load(1, 'replace')
  }, [load])

  // 首次抓取进行中：每 2 秒重取一次，最多 5 次（用 ref 调最新 load，避免闭包取到旧筛选条件）
  useEffect(() => {
    if (!pending) return
    let polls = 0
    const timer = setInterval(() => {
      polls += 1
      if (polls > PENDING_MAX_POLLS) {
        clearInterval(timer)
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
  const homepageOf = (sourceId: string) => facetSources.find((s) => s.id === sourceId)?.homepage ?? ''
  /**
   * 内容为空时区分成因（按优先级判）：
   * 1. 有源抓失败（`failures` 非空）⇒ 如实报原因 + 重试
   * 2. 还有源正在后台抓（`pending`）⇒ 加载态，不能显示成「拉不到」
   * 3. 抓完了、只是当前筛选没命中 / 库里确实没内容
   *
   * ⚠️ 注意「系统自带」是本地播种的源，所以**列表几乎不会真的为空**；`pending` 为真时
   * 内容区照常显示已有条目，只在底部计数行提示「正在抓取提示词库…」，并继续轮询。
   */
  const emptyKind: 'fetching' | 'failed' | 'filtered' | 'empty' =
    failures.length > 0 ? 'failed' : pending ? 'fetching' : hasFilter ? 'filtered' : 'empty'
  const hasContent = items.length > 0

  return (
    <WorkspaceModal title="提示词库" onClose={onClose} dialogClassName="max-w-[min(960px,94vw)]">
      {failures.length > 0 && (
        <Alert status="warning" className="mb-3">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>
              {hasContent
                ? `${failures.length} 个提示词源抓取失败，正在展示上次成功的内容`
                : `${failures.length} 个提示词源抓取失败，暂时没有可展示的内容`}
            </Alert.Title>
            <Alert.Description>{failures.map((f) => `${f.sourceName}：${f.error}`).join('；')}</Alert.Description>
            <IconButton
              variant="secondary"
              size="sm"
              className="mt-2"
              label={retrying ? '重试中…' : '重试'}
              isDisabled={retrying}
              onPress={() => void retry()}
            >
              <ArrowRotateRight className={retrying ? 'animate-spin' : undefined} />
            </IconButton>
          </Alert.Content>
        </Alert>
      )}

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
            <p className="text-xs" style={{ color: 'var(--muted)' }}>
              暂无标签
            </p>
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
            {loading ? (
              <div className="flex h-40 items-center justify-center">
                <Spinner size="md" />
              </div>
            ) : error ? (
              <div className="flex h-40 flex-col items-center justify-center gap-2 text-sm" style={{ color: 'var(--muted)' }}>
                <span>{error}</span>
                <IconButton variant="secondary" size="sm" label="重试" onPress={() => void load(1, 'replace')}>
                  <ArrowRotateRight />
                </IconButton>
              </div>
            ) : items.length === 0 ? (
              <div className="flex h-40 flex-col items-center justify-center gap-2 px-4 text-center text-sm" style={{ color: 'var(--muted)' }}>
                {emptyKind === 'fetching' ? (
                  <>
                    <Spinner size="md" />
                    <span>正在抓取提示词库…</span>
                  </>
                ) : emptyKind === 'failed' ? (
                  <>
                    <span>提示词库暂时拉不到内容，可以重试一次；也可让管理员在系统设置里刷新。</span>
                    {failures.map((f) => (
                      <span key={f.sourceId} className="text-xs">
                        {f.sourceName}：{f.error}
                      </span>
                    ))}
                    <Button variant="secondary" size="sm" className="mt-1" isDisabled={retrying} onPress={() => void retry()}>
                      {retrying ? '重试中…' : '重试'}
                    </Button>
                  </>
                ) : emptyKind === 'filtered' ? (
                  <span>没有匹配的提示词，换个关键词或标签试试</span>
                ) : (
                  <span>提示词库还没有内容</span>
                )}
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {items.map((entry) => (
                  <EntryCard
                    key={`${entry.sourceId}:${entry.id}`}
                    entry={entry}
                    sourceHomepage={homepageOf(entry.sourceId)}
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
            <span>
              {loadingMore ? '正在加载更多…' : `共 ${total} 条`}
              {pending && <span className="ms-2">（正在抓取提示词库…）</span>}
            </span>
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
