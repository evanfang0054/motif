'use client'

import { Button, Chip } from '@heroui/react'
import { TEMPLATES } from '@/lib/templates'

/** 画布空态：模板画廊，点击模板写入提示词、张数与尺寸 */
function TemplateGallery({ onSelect }: { onSelect: (key: string) => void }) {
  return (
    <div className="min-h-full">
      <div style={{ padding: '28px 24px 6px' }}>
        <h1 style={{ fontSize: 22, fontWeight: 800 }}>选一个模板，成套出图</h1>
        <p className="mt-2 text-sm" style={{ color: 'var(--canvas-muted)' }}>
          模板会自动填好提示词、张数与尺寸；你也可以直接在右侧输入自己的想法。
        </p>
      </div>
      <div className="tpl-grid">
        {TEMPLATES.map((tpl) => (
          <Button key={tpl.key} variant="secondary" className="h-auto w-full p-0 text-start align-top" onPress={() => onSelect(tpl.key)}>
            <span className="block w-full overflow-hidden rounded-2xl">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={tpl.preview} alt={tpl.title} loading="lazy" style={{ width: '100%', display: 'block' }} />
              <span className="tpl-card-body block">
                <span className="tpl-card-title block">{tpl.title}</span>
                <span className="tpl-card-desc block">{tpl.desc}</span>
                <span className="tpl-card-meta">
                  <Chip size="sm">{tpl.needsReference ? '需参考图' : '免参考'}</Chip>
                  <Chip size="sm">{tpl.count} 张</Chip>
                  <Chip size="sm">{tpl.sizeLabel}</Chip>
                </span>
              </span>
            </span>
          </Button>
        ))}
      </div>
    </div>
  )
}

export { TemplateGallery }
