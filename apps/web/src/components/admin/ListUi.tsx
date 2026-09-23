'use client'

/**
 * 管理端列表页的共用小件。
 *
 * 抽出来的原因：六个列表页在「加载中」与「空数据」两件事上必须表现一致 ——
 * 否则加载窗口里会显示「共 0 个 /（无匹配的…）」，与「真的没有数据」无法区分，会误导运营。
 *
 * 双轨过渡：HeroUI Table 形态（ListLoadingRows / ListEmptyContent）供已迁移页使用；
 * 旧 tr/td 形态（ListLoadingRow / ListEmptyRow）保留给未迁移页，全部迁移完成后删除。
 */

import { EmptyState, Pagination, Skeleton, Table, Tooltip } from '@heroui/react'

/** HeroUI Table 加载态：骨架填充行（Table.Cell 无 colSpan，按列数铺满） */
export function ListLoadingRows({ cols, rows = 3 }: { cols: number; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        <Table.Row key={`skeleton-${r}`}>
          {Array.from({ length: cols }, (_, c) => (
            <Table.Cell key={c}>
              <Skeleton className="h-4 w-3/4 rounded-medium" />
            </Table.Cell>
          ))}
        </Table.Row>
      ))}
    </>
  )
}

/** HeroUI Table 空态：塞进 Table.Body 的 renderEmptyState。只在**加载完成后**才会出现（空 children 才触发） */
export function ListEmptyContent({ text }: { text: string }) {
  return (
    <EmptyState className="flex h-full w-full flex-col items-center justify-center gap-3 py-8 text-center">
      <span className="admin-muted text-sm">{text}</span>
    </EmptyState>
  )
}

/**
 * 列表工具栏里的计数：**加载中显示骨架条**，而不是「共 0 个」。
 *
 * 为什么不能显示 0：加载窗口里「共 0 个」与「真的没有数据」无法区分，会误导运营（本文件头注释同源）。
 * 早先显示的是「共 … 个」—— 诚实但会闪一下；改成与数字等宽的骨架条，位置不跳。
 */
export function ListCount({ loading, total, unit }: { loading: boolean; total: number; unit: string }) {
  if (loading) return <Skeleton className="inline-block h-4 w-16 rounded-medium" />
  return (
    <span className="admin-muted" role="status">
      共 {total} {unit}
    </span>
  )
}

/** 分页控件。只有一页时不渲染 —— 避免给运营一个永远点不动的控件 */
export function Pager({ page, pageSize, total, onChange }: { page: number; pageSize: number; total: number; onChange: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  if (total <= pageSize) return null
  return (
    <Pagination className="admin-pager">
      <Pagination.Summary>
        <span className="admin-muted" aria-live="polite">
          第 {page} / {pages} 页
        </span>
      </Pagination.Summary>
      <Pagination.Content>
        {/* 上一页/下一页用 HeroUI 自带的 PreviousIcon / NextIcon（组件内已内置 chevron，
            原先的 <span>文字</span> 属于自造图标）；图标本身 aria-hidden，故补 aria-label + Tooltip */}
        <Pagination.Item>
          <Tooltip delay={0}>
            <Pagination.Previous isDisabled={page <= 1} aria-label="上一页" onPress={() => onChange(page - 1)}>
              <Pagination.PreviousIcon />
            </Pagination.Previous>
            <Tooltip.Content>上一页</Tooltip.Content>
          </Tooltip>
        </Pagination.Item>
        <Pagination.Item>
          <Tooltip delay={0}>
            <Pagination.Next isDisabled={page >= pages} aria-label="下一页" onPress={() => onChange(page + 1)}>
              <Pagination.NextIcon />
            </Pagination.Next>
            <Tooltip.Content>下一页</Tooltip.Content>
          </Tooltip>
        </Pagination.Item>
      </Pagination.Content>
    </Pagination>
  )
}
