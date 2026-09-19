'use client'

import { useRef } from 'react'
import { Alert, Button, NumberField, TextField, TextArea, ToggleButton, ToggleButtonGroup } from '@heroui/react'
import { SIZE_PRESETS } from '@/lib/templates'
import type { StagedReference } from '@motif/core'
import { StatusBadge } from './TopNav'

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
  onGenerate: () => void
  onCancel: () => void
  onNewTask: () => void
  /** 窄屏收起面板（<1024 显示折叠按钮，Workspace 控制开合） */
  onCollapse?: () => void
}

/** 右侧任务面板：状态、失败提示、参考图、张数、尺寸、提示词、生成/取消 */
function TaskPanel(p: Props) {
  const fileRef = useRef<HTMLInputElement>(null)
  const credits = p.credits
  const insufficient = typeof credits === 'number' && credits < p.count
  // 可移除的暂存参考（上传后、生成前）；「@ 引用」进来的画布图不进暂存列表，但仍计入 referenceCount
  const stagedOnly = p.staged

  return (
    <section className="ws-panel">
      <div className="flex items-center justify-between">
        <StatusBadge status={p.status} />
        <div className="flex items-center gap-2">
          {p.onCollapse && (
            <Button variant="secondary" className="lg:hidden" aria-label="收起生成面板" onPress={p.onCollapse}>收起</Button>
          )}
          <Button variant="secondary" onPress={p.onNewTask}>＋ 新任务</Button>
        </div>
      </div>

      {/* 上次生成失败：持久横幅（toast 转瞬即逝，失败必须留在界面上直到下次提交） */}
      {p.lastError && !p.busy && (
        <Alert status="danger" role="alert">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{p.lastError}</Alert.Title>
          </Alert.Content>
        </Alert>
      )}

      <div>
        <div className="ws-panel-label mb-1.5">参考图</div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onPress={() => fileRef.current?.click()}>
            ⬆ 上传参考图{p.referenceCount > 0 ? `（${p.referenceCount}）` : ''}
          </Button>
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
          <span className="text-xs" style={{ color: 'var(--muted)' }}>PNG / JPG / WebP ≤10MB</span>
        </div>
        {stagedOnly.length > 0 && (
          <div className="mt-2 flex flex-col gap-1.5">
            {stagedOnly.map((s) => (
              <div key={s.id} className="flex items-center gap-2 text-xs" style={{ color: 'var(--muted)' }}>
                {p.stagedPreviews[s.id] ? (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img src={p.stagedPreviews[s.id]} alt={s.name} width={34} height={34} style={{ borderRadius: 6, objectFit: 'cover', border: '1px solid var(--border)' }} />
                ) : (
                  <span
                    aria-hidden
                    style={{ width: 34, height: 34, borderRadius: 6, border: '1px solid var(--border)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                  >
                    图
                  </span>
                )}
                <span className="truncate" style={{ flex: 1, minWidth: 0 }}>{s.name}</span>
                <Button
                  variant="secondary"
                  size="sm"
                  aria-label={`移除暂存参考 ${s.name}`}
                  onPress={() => p.onRemoveStaged(s.id)}
                >
                  移除
                </Button>
              </div>
            ))}
            <p className="text-xs" style={{ color: 'var(--muted)' }}>已暂存 {stagedOnly.length} 张：点「开始生成」后进入画布</p>
          </div>
        )}
      </div>

      <div>
        <div className="ws-panel-label mb-1.5">张数</div>
        <NumberField aria-label="张数" minValue={1} maxValue={12} value={p.count} onChange={(v) => p.onCountChange(v ?? 1)} className="max-w-[120px]">
          <NumberField.Group>
            <NumberField.DecrementButton />
            <NumberField.Input />
            <NumberField.IncrementButton />
          </NumberField.Group>
        </NumberField>
      </div>

      <div>
        <div className="ws-panel-label mb-1.5">尺寸</div>
        <ToggleButtonGroup
          selectionMode="single"
          selectedKeys={new Set([p.size])}
          onSelectionChange={(keys) => {
            const k = [...keys][0]
            if (k) p.onSizeChange(String(k))
          }}
          className="ws-size-row"
        >
          {SIZE_PRESETS.map((s) => (
            <ToggleButton key={s.key} id={s.key}>
              {s.label}
              <br />
              <span style={{ color: 'var(--muted)' }}>{s.hint}</span>
            </ToggleButton>
          ))}
          <ToggleButton id="auto">
            自动
            <br />
            <span style={{ color: 'var(--muted)' }}>auto</span>
          </ToggleButton>
          <ToggleButton id="custom">
            自定义
            <br />
            <span style={{ color: 'var(--muted)' }}>输入宽高</span>
          </ToggleButton>
        </ToggleButtonGroup>
        {p.size === 'custom' && (
          <div className="mt-2 flex items-center gap-2 text-xs" style={{ color: 'var(--muted)' }}>
            <NumberField aria-label="自定义宽度" minValue={256} maxValue={2048} value={p.customW} onChange={(v) => p.onCustomSizeChange(v ?? 256, p.customH)} className="w-[90px]">
              <NumberField.Group>
                <NumberField.DecrementButton />
                <NumberField.Input />
                <NumberField.IncrementButton />
              </NumberField.Group>
            </NumberField>
            ×
            <NumberField aria-label="自定义高度" minValue={256} maxValue={2048} value={p.customH} onChange={(v) => p.onCustomSizeChange(p.customW, v ?? 256)} className="w-[90px]">
              <NumberField.Group>
                <NumberField.DecrementButton />
                <NumberField.Input />
                <NumberField.IncrementButton />
              </NumberField.Group>
            </NumberField>
            <span>像素（256–2048）</span>
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="ws-panel-label mb-1.5">提示词</div>
        <TextField aria-label="提示词" className="w-full" value={p.prompt} onChange={(v) => p.onPromptChange(v)}>
          <TextArea
            placeholder="描述你要生成的图片，或选择模板快速开始…"
            rows={5}
            className="w-full min-h-[120px] resize-y"
          />
        </TextField>
      </div>

      {/* 提交前的额度预期：本次消耗多少、余额是否够，都亮在按钮旁边而不是等服务端报错 */}
      {!p.busy && (
        <div className="text-xs" style={{ color: insufficient ? 'var(--status-failed, #b3402e)' : 'var(--muted)', minHeight: 16 }}>
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
    </section>
  )
}

export { TaskPanel }
