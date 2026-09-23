'use client'

import { useState } from 'react'
import { Alert, Button, Chip, Spinner, Typography } from '@heroui/react'
import { InlineText } from '@/components/ui/typography'
import { Copy } from '@gravity-ui/icons'
import type { PromptLibraryEntry } from '@/lib/client'
import { isAttachableImage, PROMPT_ENTRY_MAX_IMAGES } from '@/lib/prompts'
import { WorkspaceModal } from './dialogs'

interface Props {
  entry: PromptLibraryEntry
  /** 当前参考图总数（暂存 + 画布引用）：用于上限提示与「加入后 N/5」 */
  referenceCount: number
  maxReferences: number
  onClose: () => void
  /** 把第 index 张示例图带进表单（父级负责调接口、更新面板与回执） */
  onAttachImage: (index: number) => Promise<void>
  /** 复制提示词正文 */
  onCopyPrompt: () => void
}

/**
 * 提示词详情弹窗：大封面 + 示例图网格（每张可「用作参考图」）+ 描述 + 标签 + 提示词全文。
 *
 * 形态照抄上游的 `PromptDetailDialog`（大图 + 缩略图网格 + 复制提示词），
 * 但多了一步上游没有的能力：**把示例图带进表单当参考图**。
 * 图片列表由服务端算好（`entry.images`），这里的下标就是回传给服务端的下标。
 */
function PromptDetailDialog({ entry, referenceCount, maxReferences, onClose, onAttachImage, onCopyPrompt }: Props) {
  const [busyIndex, setBusyIndex] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [broken, setBroken] = useState<number[]>([])
  const images = entry.images.slice(0, PROMPT_ENTRY_MAX_IMAGES)
  const atCap = referenceCount >= maxReferences
  // **逐张**判能不能带（与服务端 `attachPromptImage` 同一份纯函数）：第三方源里可能出现
  // 「封面可带、某张缩略图不可带」的混合条目，聚合到整条上就会给不可带的那张也渲染按钮。
  const attachableAt = (index: number) => Boolean(images[index]) && isAttachableImage(images[index])
  const hasAttachable = images.some((url) => isAttachableImage(url))

  const attach = async (index: number) => {
    setBusyIndex(index)
    setError(null)
    try {
      await onAttachImage(index)
    } catch (e) {
      setError(e instanceof Error ? e.message : '加入参考图失败')
    } finally {
      setBusyIndex(null)
    }
  }

  return (
    <WorkspaceModal title={entry.title} onClose={onClose} dialogClassName="max-w-[min(760px,94vw)]">
      <div className="flex min-h-0 flex-col gap-3">
        {images.length > 0 && (
          <div className="shrink-0">
            {!broken.includes(0) ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={images[0]}
                alt={entry.title}
                className="h-48 w-full rounded-lg object-cover sm:h-56"
                onError={() => setBroken((b) => [...b, 0])}
              />
            ) : (
              <div
                className="grid h-48 w-full place-items-center rounded-lg text-xs sm:h-56"
                style={{ background: 'var(--canvas-background)', color: 'var(--muted)' }}
              >
                封面加载失败
              </div>
            )}
            {images.length > 1 && (
              <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-6">
                {images.slice(1).map((url, i) => {
                  const index = i + 1
                  return (
                    <div key={url} className="flex flex-col gap-1">
                      {broken.includes(index) ? (
                        <InlineText type="body-xs"
                          className="grid aspect-square w-full place-items-center rounded-md text-[10px]"
                          style={{ background: 'var(--canvas-background)', color: 'var(--muted)' }}
                        >
                          加载失败
                        </InlineText>
                      ) : (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img
                          src={url}
                          alt=""
                          loading="lazy"
                          className="aspect-square w-full rounded-md object-cover"
                          onError={() => setBroken((b) => [...b, index])}
                        />
                      )}
                      {attachableAt(index) && (
                        <Button
                          variant="secondary"
                          size="sm"
                          className="w-full text-[11px]"
                          isDisabled={busyIndex !== null || atCap}
                          onPress={() => void attach(index)}
                        >
                          {busyIndex === index ? '加入中…' : '用作参考图'}
                        </Button>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {error && (
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>{error}</Alert.Title>
            </Alert.Content>
          </Alert>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {attachableAt(0) && (
            <Button
              variant="primary"
              size="sm"
              isDisabled={busyIndex !== null || atCap}
              onPress={() => void attach(0)}
            >
              {busyIndex === 0 ? '加入中…' : atCap ? `参考图已达上限 ${maxReferences} 张` : '把封面用作参考图'}
            </Button>
          )}
          <Button variant="secondary" size="sm" onPress={onCopyPrompt}>
            <Copy />
            复制提示词
          </Button>
          {busyIndex !== null && <Spinner size="sm" />}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto" style={{ maxHeight: '38dvh' }}>
          {entry.tags.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {entry.tags.map((t) => (
                <Chip key={t} className="text-[10px]">
                  {t}
                </Chip>
              ))}
            </div>
          )}
          {entry.description && (
            <Typography type="body-xs" className=" leading-6" style={{ color: 'var(--muted)' }}>
              {entry.description}
            </Typography>
          )}
          <Typography type="body-sm" className="mt-2 whitespace-pre-wrap leading-7">{entry.prompt}</Typography>
        </div>

        {hasAttachable && (
          <Typography type="body-xs" className="shrink-0 leading-5" style={{ color: 'var(--muted)' }}>
            「用作参考图」会把这张示例图放进本任务的参考图暂存区（点「开始生成」后进入画布）；
            <b>提示词不会被改动</b>。
          </Typography>
        )}
      </div>
    </WorkspaceModal>
  )
}

export { PromptDetailDialog }
