'use client'

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
          <button key={tpl.key} className="tpl-card" onClick={() => onSelect(tpl.key)}>
            <img src={tpl.preview} alt={tpl.title} loading="lazy" />
            <span className="tpl-card-body block">
              <span className="tpl-card-title block">{tpl.title}</span>
              <span className="tpl-card-desc block">{tpl.desc}</span>
              <span className="tpl-card-meta">
                <span className="tpl-tag">{tpl.needsReference ? '需参考图' : '免参考'}</span>
                <span className="tpl-tag">{tpl.count} 张</span>
                <span className="tpl-tag">{tpl.sizeLabel}</span>
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

export { TemplateGallery }
