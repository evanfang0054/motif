'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CanvasImage } from '@motif/core'
import { hitTest, toWorld, type Rect } from './canvas-geometry'

/**
 * 交互画布：图片卡片在世界坐标中自由拖拽定位，
 * 支持平移视图、缩放（+/−/100%/适应）、整理布局（吸附网格）、
 * 单选/多选、选中浮动工具栏（预览/@ 引用/下载/删除）与灯箱预览。
 */

const CARD_W = 240
const SLOT = CARD_W + 40
const MIN_SCALE = 0.25
const MAX_SCALE = 3
const ZOOM_STEP = 1.2

interface View {
  x: number
  y: number
  scale: number
}

type Pos = { x: number; y: number }

function gridSlot(index: number): Pos {
  return { x: (index % 4) * SLOT, y: Math.floor(index / 4) * SLOT }
}

function cardHeight(img: CanvasImage): number {
  if (img.width > 0 && img.height > 0) return Math.round((CARD_W * img.height) / img.width)
  return CARD_W
}

function boundsOf(images: CanvasImage[], positions: Record<string, Pos>) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let any = false
  for (const img of images) {
    const p = positions[img.id]
    if (!p) continue
    any = true
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x + CARD_W)
    maxY = Math.max(maxY, p.y + cardHeight(img))
  }
  return any ? { minX, minY, maxX, maxY } : null
}

interface Props {
  images: CanvasImage[]
  onRemoveImages: (imgs: CanvasImage[]) => void
  onAddReference: (img: CanvasImage) => void
}

function CanvasBoard({ images, onRemoveImages, onAddReference }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<View>({ x: 0, y: 0, scale: 1 })
  const [positions, setPositions] = useState<Record<string, Pos>>({})
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [preview, setPreview] = useState<CanvasImage | null>(null)
  const [marquee, setMarquee] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null)
  const dragRef = useRef<{ id: string; pointerId: number; startX: number; startY: number; orig: Pos; moved: boolean } | null>(null)
  const marqueeRef = useRef<{ pointerId: number; startX: number; startY: number; moved: boolean } | null>(null)
  const fittedRef = useRef<string | null>(null)

  // 新图片出现时分配下一个网格槽位
  useEffect(() => {
    setPositions((prev) => {
      const missing = images.filter((img) => !prev[img.id])
      if (missing.length === 0) return prev
      const next = { ...prev }
      let i = Object.keys(prev).length
      for (const img of missing) {
        next[img.id] = gridSlot(i)
        i += 1
      }
      return next
    })
  }, [images])

  // 图片被移除后，同步清掉选中集里已不存在的 id（避免残留「已选 N」）
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev
      const next = new Set([...prev].filter((id) => images.some((img) => img.id === id)))
      return next.size === prev.size ? prev : next
    })
  }, [images])

  const fitView = useCallback(
    (imgs: CanvasImage[], positionsMap: Record<string, Pos>) => {
      const el = containerRef.current
      if (!el) return
      const b = boundsOf(imgs, positionsMap)
      if (!b) return
      const vw = el.clientWidth
      const vh = el.clientHeight
      const bw = b.maxX - b.minX
      const bh = b.maxY - b.minY
      const scale = Math.max(MIN_SCALE, Math.min(1.25, Math.min((vw - 80) / bw, (vh - 80) / bh)))
      setView({
        scale,
        x: (vw - bw * scale) / 2 - b.minX * scale,
        y: (vh - bh * scale) / 2 - b.minY * scale,
      })
    },
    []
  )

  // 首次出现图片时自动适应视图
  useEffect(() => {
    if (images.length > 0 && fittedRef.current !== 'fitted') {
      fittedRef.current = 'fitted'
      // 等布局槽位分配完成后再适应
      const t = setTimeout(() => fitView(images, positions), 50)
      return () => clearTimeout(t)
    }
  }, [images, positions, fitView])

  const zoomAt = useCallback((factor: number, anchorCx?: number, anchorCy?: number) => {
    const el = containerRef.current
    if (!el) return
    setView((v) => {
      const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, v.scale * factor))
      const real = scale / v.scale
      const cx = anchorCx ?? el.clientWidth / 2
      const cy = anchorCy ?? el.clientHeight / 2
      // 保持锚点下的世界坐标不动
      return {
        scale,
        x: cx - (cx - v.x) * real,
        y: cy - (cy - v.y) * real,
      }
    })
  }, [])

  const arrange = useCallback(() => {
    const next: Record<string, Pos> = {}
    images.forEach((img, i) => {
      next[img.id] = gridSlot(i)
    })
    setPositions(next)
    setTimeout(() => fitView(images, next), 0)
  }, [images, fitView])

  // ---------- 指针交互 ----------

  const startCardDrag = useCallback(
    (e: React.PointerEvent, img: CanvasImage) => {
      if (e.button !== 0) return
      e.stopPropagation()
      const el = containerRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      dragRef.current = {
        id: img.id,
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        orig: positions[img.id] ?? { x: 0, y: 0 },
        moved: false,
      }
      void rect
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    },
    [positions]
  )

  const onCardPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== e.pointerId) return
      const dx = (e.clientX - drag.startX) / view.scale
      const dy = (e.clientY - drag.startY) / view.scale
      if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 3) return
      drag.moved = true
      setPositions((prev) => ({ ...prev, [drag.id]: { x: drag.orig.x + dx, y: drag.orig.y + dy } }))
    },
    [view.scale]
  )

  const endCardDrag = useCallback(
    (e: React.PointerEvent, img: CanvasImage) => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== e.pointerId) return
      dragRef.current = null
      if (!drag.moved) {
        // 未移动视为点击：切换单选/多选（Shift 多选）
        setSelected((prev) => {
          const next = new Set(e.shiftKey ? prev : [])
          if (e.shiftKey && prev.has(img.id)) next.delete(img.id)
          else next.add(img.id)
          return next
        })
      }
    },
    []
  )

  const onCanvasPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    const el = containerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top
    // 点击/拖空白：先清空选中（拖动后由框选命中重设）
    setSelected((prev) => (prev.size ? new Set<string>() : prev))
    marqueeRef.current = { pointerId: e.pointerId, startX: sx, startY: sy, moved: false }
    setMarquee({ x1: sx, y1: sy, x2: sx, y2: sy })
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }, [])

  const onCanvasPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const m = marqueeRef.current
      if (!m || m.pointerId !== e.pointerId) return
      const el = containerRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const sx = e.clientX - rect.left
      const sy = e.clientY - rect.top
      if (!m.moved) {
        if (Math.hypot(sx - m.startX, sy - m.startY) < 3) return
        m.moved = true // 位移达阈值才算框选，否则保持「点击空白清空选中」语义
      }
      setMarquee({ x1: m.startX, y1: m.startY, x2: sx, y2: sy })
      // 实时命中预览：屏幕选框 → 世界坐标 → 与卡片矩形相交
      const a = toWorld(Math.min(m.startX, sx), Math.min(m.startY, sy), view)
      const b = toWorld(Math.max(m.startX, sx), Math.max(m.startY, sy), view)
      const cards = images.flatMap((img) => {
        const p = positions[img.id]
        return p ? [{ id: img.id, rect: { x: p.x, y: p.y, w: CARD_W, h: cardHeight(img) } as Rect }] : []
      })
      setSelected(new Set(hitTest(cards, { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y })))
    },
    [view, images, positions]
  )

  const onCanvasPointerUp = useCallback((e: React.PointerEvent) => {
    const m = marqueeRef.current
    if (!m || m.pointerId !== e.pointerId) return
    marqueeRef.current = null
    setMarquee(null)
  }, [])

  // ---------- 键盘：Esc 清除选中 / 关闭预览 ----------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPreview(null)
        setSelected((prev) => (prev.size ? new Set<string>() : prev))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ---------- 派生 ----------

  const singleSelected = useMemo(() => {
    if (selected.size !== 1) return null
    const id = [...selected][0]
    const img = images.find((i) => i.id === id)
    if (!img) return null
    const p = positions[id]
    if (!p) return null
    const el = containerRef.current
    if (!el) return null
    return {
      img,
      screenX: p.x * view.scale + view.x + (CARD_W * view.scale) / 2,
      screenY: p.y * view.scale + view.y - 12,
    }
  }, [selected, images, positions, view])

  // 多选（≥2）：计算选中包围盒的屏幕位置，供批量工具栏定位
  const multiSelected = useMemo(() => {
    if (selected.size < 2) return null
    const imgs = images.filter((i) => selected.has(i.id))
    if (imgs.length === 0) return null
    const pts = imgs.map((img) => positions[img.id]).filter((p): p is Pos => Boolean(p))
    if (pts.length === 0) return null
    const minX = Math.min(...pts.map((p) => p.x))
    const minY = Math.min(...pts.map((p) => p.y))
    const maxX = Math.max(...pts.map((p) => p.x + CARD_W))
    return {
      imgs,
      screenX: (minX + (maxX - minX) / 2) * view.scale + view.x,
      screenY: minY * view.scale + view.y - 12,
    }
  }, [selected, images, positions, view])

  return (
    <div className="relative min-h-full select-none" style={{ background: 'var(--canvas-background)' }}>
      {/* 世界画布 */}
      <div
        ref={containerRef}
        className="canvas-stage relative h-full w-full overflow-hidden touch-none"
        style={{ minHeight: 'calc(100dvh - 64px)' }}
        onPointerDown={onCanvasPointerDown}
        onPointerMove={onCanvasPointerMove}
        onPointerUp={onCanvasPointerUp}
        onWheel={(e) => {
          e.preventDefault()
          const el = containerRef.current
          if (!el) return
          const rect = el.getBoundingClientRect()
          zoomAt(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - rect.left, e.clientY - rect.top)
        }}
      >
        <div
          className="absolute left-0 top-0"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, transformOrigin: '0 0' }}
        >
          {images.map((img) => {
            const p = positions[img.id] ?? { x: 0, y: 0 }
            const isSel = selected.has(img.id)
            return (
              <figure
                key={img.id}
                className={`canvas-img-card${isSel ? ' canvas-img-card-selected' : ''}`}
                style={{ left: p.x, top: p.y, width: CARD_W, margin: 0, cursor: 'grab' }}
                onPointerDown={(e) => startCardDrag(e, img)}
                onPointerMove={onCardPointerMove}
                onPointerUp={(e) => endCardDrag(e, img)}
                onDoubleClick={() => setPreview(img)}
                aria-label={`#${String(img.serial).padStart(3, '0')} ${img.name}`}
              >
                <img src={img.src} alt={img.name} draggable={false} loading="lazy" style={{ width: '100%', display: 'block' }} />
                <figcaption className="canvas-img-label">
                  #{String(img.serial).padStart(3, '0')} {img.name}
                  {img.origin === 'uploaded' ? ' · 参考图' : ''}
                </figcaption>
              </figure>
            )
          })}
        </div>

        {/* 框选选框（屏幕坐标覆盖层） */}
        {marquee && marqueeRef.current?.moved && (
          <div
            className="canvas-marquee"
            style={{
              left: Math.min(marquee.x1, marquee.x2),
              top: Math.min(marquee.y1, marquee.y2),
              width: Math.abs(marquee.x2 - marquee.x1),
              height: Math.abs(marquee.y2 - marquee.y1),
            }}
          />
        )}

        {/* 选中图片上方浮动工具栏 */}
        {singleSelected && (
          <div
            className="canvas-toolbar"
            style={{ left: singleSelected.screenX, top: singleSelected.screenY }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <button type="button" className="canvas-tool-btn" title="放大预览" onClick={() => setPreview(singleSelected.img)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M15 3h6v6" /><path d="m21 3-7 7" /><path d="m3 21 7-7" /><path d="M9 21H3v-6" />
              </svg>
            </button>
            <button type="button" className="canvas-tool-btn canvas-tool-btn-text" title="加入参考图，并把编号写进提示词" onClick={() => onAddReference(singleSelected.img)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M16 5h6" /><path d="M19 2v6" /><path d="M21 11.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7.5" /><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" /><circle cx="9" cy="9" r="2" />
              </svg>
              @ 引用
            </button>
            <a className="canvas-tool-btn" title="下载" href={singleSelected.img.src} download={singleSelected.img.name}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 15V3" /><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5" />
              </svg>
            </a>
            <span className="canvas-tool-divider" />
            <button type="button" className="canvas-tool-btn canvas-tool-btn-danger" title="删除所选图片" onClick={() => onRemoveImages([singleSelected.img])}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M10 11v6" /><path d="M14 11v6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </button>
          </div>
        )}

        {/* 多选批量工具栏 */}
        {multiSelected && (
          <div
            className="canvas-toolbar"
            style={{ left: multiSelected.screenX, top: multiSelected.screenY }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <span className="canvas-tool-btn canvas-tool-btn-text">已选 {multiSelected.imgs.length} 张</span>
            <span className="canvas-tool-divider" />
            <button
              type="button"
              className="canvas-tool-btn canvas-tool-btn-danger"
              title="删除所选图片"
              onClick={() => onRemoveImages(multiSelected.imgs)}
            >
              删除
            </button>
          </div>
        )}
      </div>

      {/* 顶部信息与操作 */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-3">
        <div className="canvas-pill pointer-events-auto flex items-center gap-2">
          <span className="canvas-pill-count">{images.length} 张图片</span>
          {selected.size > 0 && (
            <>
              <span className="canvas-pill-divider" />
              <span className="canvas-pill-count">已选 {selected.size}</span>
              <button type="button" className="canvas-pill-btn" onClick={() => setSelected(new Set())}>清空选择</button>
            </>
          )}
        </div>
        <button type="button" className="ws-btn pointer-events-auto" onClick={arrange}>整理布局</button>
      </div>

      {/* 右下缩放控件 */}
      <div className="canvas-zoombar">
        <button type="button" className="canvas-zoom-btn" aria-label="缩小" onClick={() => zoomAt(1 / ZOOM_STEP)}>−</button>
        <button type="button" className="canvas-zoom-value" title="重置为 100%" onClick={() => zoomAt(1 / view.scale)}>{Math.round(view.scale * 100)}%</button>
        <button type="button" className="canvas-zoom-btn" aria-label="放大" onClick={() => zoomAt(ZOOM_STEP)}>＋</button>
        <span className="canvas-tool-divider" />
        <button type="button" className="canvas-zoom-btn canvas-zoom-btn-text" onClick={() => fitView(images, positions)}>适应</button>
      </div>

      {/* 屏幕阅读器图片清单 */}
      <ul className="sr-only">
        {images.map((img) => (
          <li key={img.id}>#{String(img.serial).padStart(3, '0')} {img.name}</li>
        ))}
      </ul>

      {/* 灯箱预览 */}
      {preview && (
        <div className="canvas-lightbox" role="dialog" aria-label="图片预览" onClick={() => setPreview(null)}>
          <button type="button" className="canvas-lightbox-close" aria-label="关闭预览" onClick={() => setPreview(null)}>✕</button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={preview.src} alt={preview.name} onClick={(e) => e.stopPropagation()} />
          <p className="canvas-lightbox-caption">
            #{String(preview.serial).padStart(3, '0')} {preview.name} · {preview.width}×{preview.height}
          </p>
        </div>
      )}
    </div>
  )
}

export { CanvasBoard }
