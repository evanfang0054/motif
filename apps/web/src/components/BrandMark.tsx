/**
 * 品牌 Logo —— 与 apps/web/src/app/icon.svg（站点 favicon）保持同一视觉：
 * 暖米纸底印章 + 珊瑚手绘母题 M + 打样对位角标。改 icon.svg 时请同步这里。
 *
 * 「Motif = 母题」：一笔手绘的 M 是母版，四角对位角标取自印刷打样的
 * registration mark，整体像一枚盖在暖米纸上的印章。
 * 米色块在暗色主题下呈现为「贴纸/印章」质感，亮暗两套主题共用同一图形。
 */
function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      {/* 暖米纸底 */}
      <rect width="64" height="64" rx="14" fill="#faf9f5" />
      {/* 四角对位角标 */}
      <g stroke="#cc785c" strokeWidth="2.4" strokeLinecap="round" fill="none">
        <path d="M11.5 17.5 V11.5 H17.5" />
        <path d="M46.5 11.5 H52.5 V17.5" />
        <path d="M52.5 46.5 V52.5 H46.5" />
        <path d="M17.5 52.5 H11.5 V46.5" />
      </g>
      {/* 上星下点：纹样的起止符 */}
      <path d="M32 7.2 L33.2 10.8 L36.8 12 L33.2 13.2 L32 16.8 L30.8 13.2 L27.2 12 L30.8 10.8 Z" fill="#cc785c" />
      <path d="M29.5 53.5 H34.5" stroke="#cc785c" strokeWidth="2.4" strokeLinecap="round" />
      {/* 手绘母题 M */}
      <path
        d="M19.3 43.8 C19.9 37 21.4 28.6 22.9 22.1 C26.4 27.1 29.5 32.1 32 36.7 C34.5 32.2 37.6 27.2 41.1 21.9 C42.6 28.4 44.1 36.9 44.7 43.6"
        stroke="#cc785c"
        strokeWidth="4.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  )
}

export { BrandMark }
