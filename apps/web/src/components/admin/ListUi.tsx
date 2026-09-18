'use client'

/**
 * 管理端列表页的共用小件。
 *
 * 抽出来的原因：六个列表页在「加载中」与「空数据」两件事上必须表现一致 ——
 * 否则加载窗口里会显示「共 0 个 /（无匹配的…）」，与「真的没有数据」无法区分，会误导运营。
 */

/** 加载中的占位行。用 role="status" 让读屏也能感知状态变化 */
export function ListLoadingRow({ colSpan }: { colSpan: number }) {
  return (
    <tr>
      <td colSpan={colSpan} className="admin-muted" role="status">
        加载中…
      </td>
    </tr>
  )
}

/** 空态行。只在**加载完成后**才渲染，避免与加载态混淆 */
export function ListEmptyRow({ colSpan, text }: { colSpan: number; text: string }) {
  return (
    <tr>
      <td colSpan={colSpan} className="admin-muted">
        {text}
      </td>
    </tr>
  )
}

/** 列表工具栏里的计数：加载中显示省略号而不是 0 */
export function ListCount({ loading, total, unit }: { loading: boolean; total: number; unit: string }) {
  return <span className="admin-muted">共 {loading ? '…' : total} {unit}</span>
}

/** 分页控件。只有一页时不渲染 —— 避免给运营一个永远点不动的控件 */
export function Pager({ page, pageSize, total, onChange }: { page: number; pageSize: number; total: number; onChange: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  if (total <= pageSize) return null
  return (
    <nav className="admin-pager" aria-label="分页">
      <button type="button" disabled={page <= 1} onClick={() => onChange(page - 1)}>
        上一页
      </button>
      <span className="admin-muted" aria-live="polite">
        第 {page} / {pages} 页
      </span>
      <button type="button" disabled={page >= pages} onClick={() => onChange(page + 1)}>
        下一页
      </button>
    </nav>
  )
}
