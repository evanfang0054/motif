'use client'

import { useEffect, useRef } from 'react'
import { Alert, Button, Description, Dropdown, Label, NumberField, TextArea, TextField, Typography } from '@heroui/react'
import { InlineText } from '@/components/ui/typography'
import { ArrowUpToLine, BookOpen, ChevronDown, Eraser, Plus, Xmark } from '@gravity-ui/icons'
import { IconButton } from '@/components/ui/icon-button'
import { SIZE_PRESETS, sizeLabelOf } from '@/lib/templates'
import { MAX_REFERENCE_IMAGES, TOPIC_STATUS_LABEL, finiteNumber } from '@motif/core'
import type { CanvasImage, StagedReference } from '@motif/core'

interface Props {
  status: string
  prompt: string
  count: number
  size: string
  customW: number
  customH: number
  referenceCount: number
  staged: StagedReference[]
  stagedPreviews: Record<string, string>
  /** 画布「@ 引用」进来的参考图（已在画布里，可单独取消引用而不删图） */
  canvasReferences: CanvasImage[]
  busy: boolean
  /** 当前余额：用于生成前的消耗提示与不足预警 */
  credits?: number
  /** 最近一次生成失败的信息（含已退额提示）；重新提交后由父级自动清除 */
  lastError?: string | null
  onPromptChange: (v: string) => void
  onCountChange: (v: number) => void
  onSizeChange: (v: string) => void
  onCustomSizeChange: (w: number, h: number) => void
  onUploadReference: (file: File) => void
  onRemoveStaged: (id: string) => void
  /** 取消引用画布图（只摘掉参考关系，画布里的图仍在） */
  onRemoveCanvasReference: (id: string) => void
  /** 打开提示词库弹窗（从现成提示词里挑一条填进输入框） */
  onOpenPromptLibrary: () => void
  onGenerate: () => void
  onCancel: () => void
  onNewTask: () => void
}

/** 提示词输入框的自适应高度上限：再高就把「参数」区挤出视野了 */
const PROMPT_MAX_H = 320

/**
 * NumberField 的取值兜底。
 *
 * ⚠️ RAC 的 NumberField 在输入框被**清空并失焦**时给的是 `NaN`，**不是 `null`** ——
 * `v ?? fallback` 拦不住 NaN，NaN 会被原样写进状态，后果是：
 * 输入框从此显示空白（`NaN` 渲染成空串）、页脚变成「本次将消耗 **NaN** 张」，
 * 而且加减号看起来「点了没反应」（`NaN ± step` 仍是 NaN，只有 RAC 自己回落到 minValue 才恢复）。
 * 服务端有 `validateCount` 兜底（`!Number.isInteger(NaN)` → 拒绝），所以不会真的按 NaN 计费，
 * 但界面这一层必须自己挡住 —— 实测复现路径：选中张数输入框 → 退格清空 → 点别处失焦。
 * 判据用 `@motif/core` 的 `finiteNumber`（同一份实现，别再抄一份）。
 */

/** 供面板复用的状态徽标 */
function StatusBadge({ status }: { status: string }) {
  const label = TOPIC_STATUS_LABEL[status as keyof typeof TOPIC_STATUS_LABEL] ?? status
  const color =
    ({
      running: 'var(--status-running)',
      pending: 'var(--status-pending)',
      canceling: 'var(--status-canceling)',
      failed: 'var(--status-failed)',
      canceled: 'var(--status-canceled)',
      completed: 'var(--status-completed)',
    } as Record<string, string>)[status] ?? 'var(--status-idle)'
  return (
    <InlineText type="body-xs" className="ws-badge">
      <span className="ws-status-dot" style={{ background: color }} />
      {label}
    </InlineText>
  )
}

/**
 * 右侧生成面板。
 *
 * 2026-09-21 用户裁决的布局重做：
 * ① 尺寸由「5 个各占两行文字、会折行的按钮」改成**一行紧凑下拉**（选项里才带尺寸数字）；
 * ② 张数与尺寸**并成一行**（两个短字段不再各占一行）；
 * ③ 加分组标题与分隔线，把「参考图 / 参数 / 提示词」三段分清；
 * ④ 参考图区重整：**上传入口做成网格里的第一格**（虚线框），缩略图紧跟其后，空态给说明；
 * ⑤ 提示词框**随内容自适应高度** + 「清空」快捷操作。
 */
function TaskPanel(p: Props) {
  const fileRef = useRef<HTMLInputElement>(null)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const credits = p.credits
  const insufficient = typeof credits === 'number' && credits < p.count
  // 可移除的暂存参考（上传后、生成前）；「@ 引用」进来的画布图不进暂存列表，但仍计入 referenceCount
  const stagedOnly = p.staged
  const canvasOnly = p.canvasReferences
  const hasReferenceRows = canvasOnly.length > 0 || stagedOnly.length > 0
  // 上传与「@ 引用」共用同一个上限：这里只看总量，满了就不让再选文件
  const atReferenceCap = p.referenceCount >= MAX_REFERENCE_IMAGES
  const sizeLabel = sizeLabelOf(p.size)

  // 提示词框随内容长高（到上限为止）。⚠️ 先把 height 归零再读 scrollHeight，
  // 否则删字时 scrollHeight 会被上一轮的内联高度撑住，框只增不减。
  useEffect(() => {
    const el = promptRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, PROMPT_MAX_H)}px`
  }, [p.prompt])

  return (
    <div className="ws-panel">
      {/* 面板头（状态 + 新任务）**不参与滚动**：状态是「现在在发生什么」的读数，滚走就看不到了。
          ⚠️ 这里**没有**收起按钮（2026-09-21 用户裁决）：本面板的收起入口是**点画布空白处**，
          面板头再放一个按钮就是重复入口（左侧面板相反 —— 它只能靠自己的按钮收起）。 */}
      <div className="ws-panel-head">
        <StatusBadge status={p.status} />
        <IconButton variant="secondary" size="sm" label="新任务" onPress={p.onNewTask}>
          <Plus />
        </IconButton>
      </div>

      <div className="ws-panel-scroll">
        {/* 上次生成失败：持久横幅（toast 转瞬即逝，失败必须留在界面上直到下次提交） */}
        {p.lastError && !p.busy && (
          <Alert status="danger" role="alert">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>{p.lastError}</Alert.Title>
            </Alert.Content>
          </Alert>
        )}

        {/* ── 参考图 ─────────────────────────────────────────── */}
        <div>
          {/* 计数放**段标题行**而不是上传按钮上：按钮满额时会 disabled（原生 disabled + pointer-events:none），
              提示浮层打不开，用户既看不到「几／几」也不知道为什么点不动 —— 段标题永远可见，且下面还有一行
              文字直说原因（见下方 atReferenceCap 分支） */}
          <div className="mb-2 flex items-center justify-between">
            <InlineText type="body-sm" className="ws-panel-label">参考图</InlineText>
            <InlineText type="body-xs" style={{ color: atReferenceCap ? 'var(--danger-quiet)' : 'var(--muted)' }}>
              {p.referenceCount} / {MAX_REFERENCE_IMAGES}
            </InlineText>
          </div>
          <div className="grid grid-cols-4 gap-2">
            {/* 上传入口就是网格的第一格：空态时它是唯一的格子，一眼知道「从这里加图」 */}
            <button
              type="button"
              className="ws-ref-add"
              disabled={atReferenceCap}
              aria-label={`上传参考图（${p.referenceCount}／${MAX_REFERENCE_IMAGES}）`}
              onClick={() => fileRef.current?.click()}
            >
              <ArrowUpToLine />
              <span>上传</span>
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) p.onUploadReference(f)
                e.target.value = ''
              }}
            />
            {canvasOnly.map((c) => {
              const label = `#${String(c.serial).padStart(3, '0')}`
              return (
                <div key={c.id} className="flex min-w-0 flex-col items-center gap-1">
                  <div className="relative w-full">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={c.src}
                      alt={c.name}
                      title={`${label} ${c.name}`}
                      className="aspect-square w-full rounded-md border object-cover"
                      style={{ borderColor: 'var(--border)' }}
                    />
                    <IconButton
                      variant="secondary"
                      size="sm"
                      className="absolute right-0.5 top-0.5"
                      label="取消引用"
                      ariaLabel={`移除画布引用 ${c.name}`}
                      tooltip="只取消引用，不删图"
                      onPress={() => p.onRemoveCanvasReference(c.id)}
                    >
                      <Xmark />
                    </IconButton>
                  </div>
                  <InlineText type="body-xs" className="w-full truncate text-center text-[11px]" style={{ color: 'var(--muted)' }} title={`${label} ${c.name}`}>
                    {label}
                  </InlineText>
                </div>
              )
            })}
            {stagedOnly.map((s) => (
              <div key={s.id} className="flex min-w-0 flex-col items-center gap-1">
                <div className="relative w-full">
                  {p.stagedPreviews[s.id] ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                      src={p.stagedPreviews[s.id]}
                      alt={s.name}
                      title={s.name}
                      className="aspect-square w-full rounded-md border object-cover"
                      style={{ borderColor: 'var(--border)' }}
                    />
                  ) : (
                    <span
                      aria-hidden
                      title={s.name}
                      className="flex aspect-square w-full items-center justify-center rounded-md border text-xs"
                      style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}
                    >
                      图
                    </span>
                  )}
                  <IconButton
                    variant="secondary"
                    size="sm"
                    className="absolute right-0.5 top-0.5"
                    label="移除暂存"
                    ariaLabel={`移除暂存参考 ${s.name}`}
                    tooltip="从暂存列表移除"
                    onPress={() => p.onRemoveStaged(s.id)}
                  >
                    <Xmark />
                  </IconButton>
                </div>
                <InlineText type="body-xs" className="w-full truncate text-center text-[11px]" style={{ color: 'var(--muted)' }} title={s.name}>
                  {s.name}
                </InlineText>
              </div>
            ))}
          </div>
          <Typography type="body-xs" className="mt-2" style={{ color: 'var(--muted)' }}>
            {atReferenceCap
              ? `已达上限 ${MAX_REFERENCE_IMAGES} 张，移除一张后可继续上传`
              : hasReferenceRows
                ? [
                    canvasOnly.length > 0 ? `已引用画布图 ${canvasOnly.length} 张（移除只取消引用，不删图）` : '',
                    stagedOnly.length > 0 ? `已暂存 ${stagedOnly.length} 张：点「生成」后进入画布` : '',
                  ]
                    .filter(Boolean)
                    .join('；')
                : '支持 PNG / JPG / WebP，单张 ≤10MB'}
          </Typography>
        </div>

        {/* ── 参数 ──────────────────────────────────────────── */}
        <div className="ws-panel-section">
          <div className="mb-2 ws-panel-label">参数</div>
          {/* 张数与尺寸并排：两个都是短字段，各占一行纯属浪费垂直空间 */}
          <div className="flex items-end gap-4">
            <div>
              <div className="mb-1 text-xs" style={{ color: 'var(--muted)' }}>张数</div>
              <NumberField
                aria-label="张数"
                minValue={1}
                maxValue={12}
                value={p.count}
                onChange={(v) => p.onCountChange(finiteNumber(v, 1))}
                className="w-[144px]"
              >
                <NumberField.Group>
                  <NumberField.DecrementButton />
                  <NumberField.Input />
                  <NumberField.IncrementButton />
                </NumberField.Group>
              </NumberField>
            </div>
            <div className="min-w-0">
              <div className="mb-1 text-xs" style={{ color: 'var(--muted)' }}>尺寸</div>
              {/* 触发件必须是 Dropdown 的**直接子元素**：Dropdown.Trigger 内部会再渲染一个 HeroUI Button，
                  写成 <Trigger><Button/></Trigger> 会得到 <button> 套 <button>（React 19 报 validateDOMNesting，
                  且 isDisabled 落在内层、靠冒泡被吃掉才偶然生效） */}
              <Dropdown>
                <Button variant="secondary" aria-label={`尺寸：${sizeLabel}`} className="min-w-[104px] justify-between">
                  {sizeLabel}
                  <ChevronDown />
                </Button>
                <Dropdown.Popover>
                  <Dropdown.Menu
                    selectionMode="single"
                    selectedKeys={new Set([p.size])}
                    onSelectionChange={(keys) => {
                      const k = [...keys][0]
                      if (k) p.onSizeChange(String(k))
                    }}
                  >
                    {SIZE_PRESETS.map((s) => (
                      <Dropdown.Item key={s.key} id={s.key} textValue={`${s.label} ${s.hint}`}>
                        <Label>{s.label}</Label>
                        <Description>{s.hint}</Description>
                      </Dropdown.Item>
                    ))}
                    <Dropdown.Item id="auto" textValue="自动 auto">
                      <Label>自动</Label>
                      <Description>auto</Description>
                    </Dropdown.Item>
                    <Dropdown.Item id="custom" textValue="自定义 输入宽高">
                      <Label>自定义</Label>
                      <Description>输入宽高</Description>
                    </Dropdown.Item>
                  </Dropdown.Menu>
                </Dropdown.Popover>
              </Dropdown>
            </div>
          </div>
          {/* ⚠️ 自定义宽高那一行的宽度是**按「输入框必须放得下数字」算出来的**，不能随手改小：
              HeroUI 的 `.number-field__group` 是 `grid-template-columns: 40px <余量> 40px`，
              而 Input 自带 12px 左右内边距 —— 外层给 90px 时中间只剩 10px，
              减掉 24px 内边距后内容宽度是**负数**，数字被 `overflow: clip` 整段裁掉。
              `flex-wrap` 是配套的：两个 144px 字段 + × + 说明文字在窄屏放不下一行，允许换行而不是溢出。 */}
          {p.size === 'custom' && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs" style={{ color: 'var(--muted)' }}>
              <NumberField aria-label="自定义宽度" minValue={256} maxValue={2048} value={p.customW} onChange={(v) => p.onCustomSizeChange(finiteNumber(v, 256), p.customH)} className="w-[144px]">
                <NumberField.Group>
                  <NumberField.DecrementButton />
                  <NumberField.Input />
                  <NumberField.IncrementButton />
                </NumberField.Group>
              </NumberField>
              ×
              <NumberField aria-label="自定义高度" minValue={256} maxValue={2048} value={p.customH} onChange={(v) => p.onCustomSizeChange(p.customW, finiteNumber(v, 256))} className="w-[144px]">
                <NumberField.Group>
                  <NumberField.DecrementButton />
                  <NumberField.Input />
                  <NumberField.IncrementButton />
                </NumberField.Group>
              </NumberField>
              <InlineText type="body-sm">像素（256–2048）</InlineText>
            </div>
          )}
        </div>

        {/* ── 提示词 ────────────────────────────────────────── */}
        <div className="ws-panel-section">
          {/* 唯一的提示词入口：系统自带的 8 套模板提示词也都在库里（用户裁决 2026-09-21 并入） */}
          <div className="mb-2 flex items-center justify-between">
            <InlineText type="body-sm" className="ws-panel-label">提示词</InlineText>
            <div className="flex items-center gap-1">
              <IconButton
                variant="secondary"
                size="sm"
                label="清空提示词"
                isDisabled={!p.prompt}
                onPress={() => p.onPromptChange('')}
              >
                <Eraser />
              </IconButton>
              <IconButton variant="secondary" size="sm" label="提示词库" onPress={p.onOpenPromptLibrary}>
                <BookOpen />
              </IconButton>
            </div>
          </div>
          <TextField aria-label="提示词" className="w-full" value={p.prompt} onChange={(v) => p.onPromptChange(v)}>
            <TextArea
              ref={promptRef}
              placeholder="描述你要生成的图片，或从提示词库挑一条…"
              rows={4}
              className="w-full min-h-[104px] resize-none"
            />
          </TextField>
        </div>
      </div>

      {/* 提交区**吸底常驻**：面板内容会长到需要滚动，而「生成」是唯一的终点动作，
          滚到底才能点等于每次都要多一次滚动。
          它是 .ws-panel 的**普通 flex 子项**（不是 sticky）—— 见 globals.css 里那段说明 */}
      <div className="ws-panel-footer">
        {/* 提交前的额度预期：本次消耗多少、余额是否够，都亮在按钮旁边而不是等服务端报错 */}
        {!p.busy && (
          <div className="text-xs" style={{ color: insufficient ? 'var(--danger-quiet)' : 'var(--muted)', minHeight: 16 }}>
            {insufficient
              ? `本次将消耗 ${p.count} 张，当前余额仅 ${credits} 张，请充值或调小张数`
              : typeof credits === 'number'
                ? `本次将消耗 ${p.count} 张，余额 ${credits} 张`
                : null}
          </div>
        )}

        {p.busy ? (
          <Button variant="secondary" className="w-full" onPress={p.onCancel}>
            取消生成
          </Button>
        ) : (
          <Button variant="primary" className="w-full" onPress={p.onGenerate} isDisabled={!p.prompt.trim()}>
            {p.prompt.trim() ? `生成（${p.count} 张）` : '生成'}
          </Button>
        )}
      </div>
    </div>
  )
}

export { TaskPanel, StatusBadge }
