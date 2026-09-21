/**
 * 画布空态的新手引导。
 *
 * 空态不承担「挑提示词」的职责，只负责说清「从零开始怎么出第一套图」；
 * 底部的按钮只是**打开提示词库**的快捷入口 —— 系统自带的 8 套模板提示词也在库里
 * （用户裁决 2026-09-21 把模板并入提示词库，并去掉了原先那个「一次填好张数/尺寸」的下拉）。
 */
'use client'

import { Button, Surface } from '@heroui/react'
import { BookOpen } from '@gravity-ui/icons'

interface Props {
  onOpenPromptLibrary: () => void
}

const STEPS: Array<{ title: string; desc: string }> = [
  { title: '写提示词', desc: '在右侧表单里描述你要生成的图片；张数与尺寸也在那里选。' },
  { title: '可选：上传参考图', desc: '想让主体在整组图里保持一致就上传参考图。上传后只暂存，生成时才进画布。' },
  { title: '点「生成」', desc: '出图后会自动落在画布上，可以拖动、缩放，Shift+拖拽框选，也可以导出布局。' },
]

function CanvasEmptyGuide({ onOpenPromptLibrary }: Props) {
  return (
    <div className="flex h-full items-center justify-center p-6" data-testid="canvas-empty-guide">
      <Surface className="w-full max-w-[520px] rounded-2xl p-6">
        <h2 className="text-lg font-semibold" style={{ color: 'var(--foreground)' }}>从零开始做一套图</h2>
        <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>画布现在是空的，三步就能出第一套图：</p>

        <ol className="mt-4 flex flex-col gap-3">
          {STEPS.map((step, i) => (
            <li key={step.title} className="flex gap-3">
              <span
                aria-hidden
                className="text-xs font-medium"
                style={{
                  flex: '0 0 auto',
                  width: 22,
                  height: 22,
                  borderRadius: 999,
                  border: '1px solid var(--border)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--muted-strong)',
                }}
              >
                {i + 1}
              </span>
              <div style={{ minWidth: 0 }}>
                <div className="text-sm font-medium" style={{ color: 'var(--foreground)' }}>{step.title}</div>
                <div className="text-xs" style={{ color: 'var(--muted)', lineHeight: 1.7 }}>{step.desc}</div>
              </div>
            </li>
          ))}
        </ol>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          {/* 空态里这是**唯一**的入口，保留文字（图标化会把新手引导藏进悬停里），只补图标做视觉对齐 */}
          <Button variant="secondary" onPress={onOpenPromptLibrary}>
            <BookOpen />
            打开提示词库
          </Button>
          <span className="text-xs" style={{ color: 'var(--muted)' }}>
            系统自带的 8 套模板提示词都在里面，挑一条填进右侧表单
          </span>
        </div>
      </Surface>
    </div>
  )
}

export { CanvasEmptyGuide }
