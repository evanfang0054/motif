'use client'

import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Link, Spinner, Table } from '@heroui/react'
import { ArrowRotateLeft, ArrowRotateRight, ArrowUpRightFromSquare } from '@gravity-ui/icons'
import { api, type AdminPromptSource } from '@/lib/client'
import { ListEmptyContent, ListLoadingRows } from './ListUi'
import { showToast } from '@/components/ui/toast'

/** 时间戳展示：空值给「—」而不是 Invalid Date */
function fmtTime(value: string | null): string {
  if (!value) return '—'
  const t = new Date(value)
  return Number.isNaN(t.getTime()) ? '—' : t.toLocaleString()
}

/**
 * 提示词库分区：全部提示词源的状态 + 「立即刷新」。
 *
 * 这个分区**没有配置键**（`SETTING_DEFS` 里没有 `prompts` 组的项）—— 它承载的是动作，
 * 不是配置。所以设置页对它的处理与其它分区不同：不渲染保存按钮，改渲染本面板。
 *
 * 手动刷新**绕过**自动重试节奏：抓取失败后 5 分钟内不会再自动重抓，这是唯一的人工恢复路径。
 */
function PromptSourcePanel() {
  const [sources, setSources] = useState<AdminPromptSource[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api.adminListPromptSources()
      setSources(r.sources)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const refresh = async () => {
    setRefreshing(true)
    setError(null)
    try {
      const r = await api.adminRefreshPrompts()
      setSources(r.sources)
      const { successCount, failureCount, total } = r.summary
      showToast({
        tone: failureCount > 0 ? 'warning' : 'success',
        message:
          failureCount > 0
            ? `成功 ${successCount} 个源、共 ${total} 条；${failureCount} 个源失败（见下表原因）`
            : `已刷新 ${successCount} 个源、共 ${total} 条`,
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : '刷新失败')
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs" style={{ color: 'var(--muted)', lineHeight: 1.8 }}>
        提示词库的内容由服务端从上游开源提示词仓库抓取并缓存（成功源 1 小时自动更新一次）。
        抓取失败时用户侧继续展示上次成功的内容；失败源 5 分钟内不会自动重试，
        点「立即刷新」可立刻重试。5 个上游源 + 本地播种的「系统自带」都在这里列着，
        上游源的条目数为 0 表示还没抓到过。
      </p>

      {error && (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{error}</Alert.Title>
          </Alert.Content>
        </Alert>
      )}

      <div className="flex items-center gap-2">
        {/* 这是本面板的主操作，且刷新中会 disabled → 保留可见文字 */}
        <Button variant="primary" isDisabled={refreshing} onPress={() => void refresh()}>
          <ArrowRotateRight className={refreshing ? 'animate-spin' : undefined} />
          {refreshing ? '刷新中…' : '立即刷新'}
        </Button>
        {refreshing && <Spinner size="sm" />}
        <Button variant="secondary" isDisabled={refreshing} onPress={() => void load()}>
          <ArrowRotateLeft />
          重新加载
        </Button>
      </div>

      <Table>
        <Table.ScrollContainer className="admin-table-scroll">
          <Table.Content aria-label="提示词源状态">
            <Table.Header>
              <Table.Column isRowHeader>提示词源</Table.Column>
              <Table.Column>条目数</Table.Column>
              <Table.Column>上次成功</Table.Column>
              <Table.Column>上次错误</Table.Column>
              <Table.Column>源地址</Table.Column>
            </Table.Header>
            <Table.Body renderEmptyState={() => (loading ? null : <ListEmptyContent text="（还没有抓取过）" />)}>
              {loading ? (
                <ListLoadingRows cols={5} />
              ) : (
                sources.map((s) => (
                  <Table.Row key={s.id}>
                    <Table.Cell data-label="提示词源">{s.name}</Table.Cell>
                    <Table.Cell data-label="条目数">{s.entryCount}</Table.Cell>
                    <Table.Cell data-label="上次成功">{fmtTime(s.lastSuccessAt)}</Table.Cell>
                    <Table.Cell data-label="上次错误">
                      {s.lastError ? (
                        <span style={{ color: 'var(--danger-quiet)' }} title={s.lastError}>
                          {s.lastError.length > 60 ? `${s.lastError.slice(0, 60)}…` : s.lastError}
                        </span>
                      ) : (
                        '—'
                      )}
                    </Table.Cell>
                    <Table.Cell data-label="源地址">
                      {s.homepage ? (
                        <Link href={s.homepage} target="_blank" rel="noreferrer noopener" className="text-xs">
                          原仓库 <ArrowUpRightFromSquare className="ms-1 inline align-[-0.125em]" aria-hidden />
                        </Link>
                      ) : (
                        '—'
                      )}
                    </Table.Cell>
                  </Table.Row>
                ))
              )}
            </Table.Body>
          </Table.Content>
        </Table.ScrollContainer>
      </Table>
    </div>
  )
}

export { PromptSourcePanel }
