import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * 用户侧的「重试提示词源」入口已整体下线。
 *
 * 抓取失败是**运维信息**：它既无用户可执行的动作，又暴露了「有几个上游仓库挂了」这类内部实现。
 * 重抓的能力保留在管理端（系统设置 → 提示词库 → 立即刷新），用户侧只做静默降级
 * —— 失败时就是「看到上次成功的内容」或「还没有内容」，与正常情况无差别。
 *
 * ⚠️ 这里断言的是**路由文件不存在**（等价于 `POST /api/prompts/retry` 返回 404）：
 * 文件删掉后没有模块可 import，用 `existsSync` 是唯一能钉住「它真的没了」的方式。
 * 若将来有人把它加回来，这条会立刻变红。
 */
describe('用户侧重试提示词源已下线', () => {
  it('重试路由文件不存在（POST 会 404）', () => {
    const route = fileURLToPath(new URL('../src/app/api/prompts/retry/route.ts', import.meta.url))
    expect(existsSync(route)).toBe(false)
  })
})
