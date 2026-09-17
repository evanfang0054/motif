import { useId } from 'react'

/**
 * 品牌 Logo —— 与 apps/web/src/app/icon.svg（站点 favicon）保持同一视觉：
 * 珊瑚渐变圆角方块 + 白色粗体「M」。改 icon.svg 时请同步这里。
 */
function BrandMark({ size = 28 }: { size?: number }) {
  const gid = 'bm' + useId().replace(/[^a-zA-Z0-9]/g, '')
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#cc785c" />
          <stop offset="1" stopColor="#e8a55a" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="14" fill={`url(#${gid})`} />
      <text x="32" y="44" textAnchor="middle" fontFamily="Arial, sans-serif" fontSize="34" fontWeight="800" fill="#ffffff">
        M
      </text>
    </svg>
  )
}

export { BrandMark }
