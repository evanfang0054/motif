'use client'

import { useRef } from 'react'
import { SIZE_PRESETS } from '@/lib/templates'
import { StatusBadge } from './TopNav'

interface Props {
  status: string
  prompt: string
  count: number
  size: string
  customW: number
  customH: number
  referenceCount: number
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

  return (
    <section className="ws-panel">
      <div className="flex items-center justify-between">
        <StatusBadge status={p.status} />
        <div className="flex items-center gap-2">
          {p.onCollapse && (
            <button className="ws-btn lg:hidden" aria-label="收起生成面板" onClick={p.onCollapse}>收起</button>
          )}
          <button className="ws-btn" onClick={p.onNewTask}>＋ 新任务</button>
        </div>
      </div>

      {/* 上次生成失败：持久横幅（toast 转瞬即逝，失败必须留在界面上直到下次提交） */}
      {p.lastError && !p.busy && (
        <div
          role="alert"
          className="text-xs"
          style={{
            padding: '8px 12px',
            borderRadius: 10,
            border: '1px solid color-mix(in srgb, var(--status-failed, #b3402e) 45%, transparent)',
            background: 'color-mix(in srgb, var(--status-failed, #b3402e) 10%, transparent)',
            color: 'var(--status-failed, #b3402e)',
            lineHeight: 1.6,
          }}
        >
          {p.lastError}
        </div>
      )}

      <div>
        <div className="ws-panel-label mb-1.5">参考图</div>
        <div className="flex items-center gap-2">
          <button className="ws-btn" onClick={() => fileRef.current?.click()}>
            ⬆ 上传参考图{p.referenceCount > 0 ? `（${p.referenceCount}）` : ''}
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
          <span className="text-xs" style={{ color: 'var(--muted)' }}>PNG / JPG / WebP ≤10MB</span>
        </div>
      </div>

      <div>
        <div className="ws-panel-label mb-1.5">张数</div>
        <input
          className="lp-input"
          type="number"
          min={1}
          max={12}
          value={p.count}
          onChange={(e) => p.onCountChange(Math.max(1, Math.min(12, Number(e.target.value) || 1)))}
          style={{ maxWidth: 120 }}
        />
      </div>

      <div>
        <div className="ws-panel-label mb-1.5">尺寸</div>
        <div className="ws-size-row">
          {SIZE_PRESETS.map((s) => (
            <button key={s.key} className="ws-size-chip" data-active={p.size === s.key} onClick={() => p.onSizeChange(s.key)}>
              {s.label}
              <br />
              <span style={{ color: 'var(--muted)' }}>{s.hint}</span>
            </button>
          ))}
          <button className="ws-size-chip" data-active={p.size === 'auto'} onClick={() => p.onSizeChange('auto')}>
            自动
            <br />
            <span style={{ color: 'var(--muted)' }}>auto</span>
          </button>
          <button className="ws-size-chip" data-active={p.size === 'custom'} onClick={() => p.onSizeChange('custom')}>
            自定义
            <br />
            <span style={{ color: 'var(--muted)' }}>输入宽高</span>
          </button>
        </div>
        {p.size === 'custom' && (
          <div className="mt-2 flex items-center gap-2 text-xs" style={{ color: 'var(--muted)' }}>
            <input
              className="lp-input"
              type="number"
              min={256}
              max={2048}
              value={p.customW}
              onChange={(e) => p.onCustomSizeChange(Number(e.target.value) || 256, p.customH)}
              style={{ width: 90 }}
            />
            ×
            <input
              className="lp-input"
              type="number"
              min={256}
              max={2048}
              value={p.customH}
              onChange={(e) => p.onCustomSizeChange(p.customW, Number(e.target.value) || 256)}
              style={{ width: 90 }}
            />
            <span>像素（256–2048）</span>
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="ws-panel-label mb-1.5">提示词</div>
        <textarea
          className="ws-textarea"
          value={p.prompt}
          onChange={(e) => p.onPromptChange(e.target.value)}
          placeholder="描述你要生成的图片，或选择模板快速开始…"
        />
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
        <button className="ws-btn" style={{ justifyContent: 'center', padding: '11px 0' }} onClick={p.onCancel}>
          取消生成
        </button>
      ) : (
        <button
          className="ws-btn ws-btn-primary"
          style={{ justifyContent: 'center', padding: '11px 0' }}
          onClick={p.onGenerate}
          disabled={!p.prompt.trim()}
          title={!p.prompt.trim() ? '请先输入提示词，或点击上方模板快速开始' : undefined}
        >
          {p.prompt.trim() ? `生成（${p.count} 张）` : '生成'}
        </button>
      )}
    </section>
  )
}

export { TaskPanel }
