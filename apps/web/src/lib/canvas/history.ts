/**
 * 撤销栈：**手势边界式**（begin → 内存自由变更 → commit），而非逐帧入栈。
 *
 * 参考 `.infinite-canvas-ref/src/stores/canvas/use-canvas-store.ts:45-67` 的
 * 「400ms 防抖 + 引用相等短路」写法。适配改动：上游没有撤销栈，这里把「连续变更
 * 合并为一次」的思路用在手势上 —— 拖拽期间位置逐帧更新但只入栈一次。
 *
 * ⚠️ 撤销栈**不覆盖服务端删除**。机制保证：删除走 `api.deleteCanvasImages`
 * 完全不同的路径，从不调用本模块的 begin/commit，故栈里不可能有删除操作。
 * 这与既有确认文案「删除后无法恢复」一致 —— 该文案由 `deleteImageConfirmText`
 * 产出（`components/workspace/canvas-geometry.ts`，渲染于 `Workspace.tsx:561`）。
 * ⚠️ 引用符号名而非行号：该文件已被削成只剩这一个函数，行号会再变。
 *
 * ⚠️ 上游**没有撤销栈实现**（`.infinite-canvas-ref/src/stores/canvas/use-canvas-store.ts`
 * 只有 project 的增删改，无 undo/redo），故本模块的 API（begin/commit/undo/redo）是
 * 自定的、无源可抄 —— 属「自定 API 须写明出处与理由」的情形，已在设计记录里记账。
 */

export interface CanvasHistory<S> {
  /** 手势开始：记录基准快照；同 key 重复调用不覆盖（拖拽中每帧都会调） */
  begin(key: string, current: S): void
  /** 手势结束：把基准入栈、清空重做栈；无进行中的手势则无操作 */
  commit(): void
  /** 手势作废：丢弃基准快照、不入栈（用于「点了但没拖动」这类空手势） */
  cancel(): void
  /** 撤销：返回上一个状态；栈空返回 null */
  undo(current: S): S | null
  /** 重做：返回下一个状态；栈空返回 null */
  redo(current: S): S | null
  canUndo(): boolean
  canRedo(): boolean
  /** 当前可撤销步数（测试/调试用） */
  depth(): number
}

export function createCanvasHistory<S>(limit = 50): CanvasHistory<S> {
  const past: S[] = []
  const future: S[] = []
  let pending: { key: string; snapshot: S } | null = null

  const trim = () => {
    while (past.length > limit) past.shift()
  }

  return {
    begin(key, current) {
      if (pending && pending.key === key) return // 同一次手势：基准不覆盖
      if (pending) {
        // 上一次手势没 commit 就开始了新的：先把它的基准入栈，避免丢步
        past.push(pending.snapshot)
        trim()
      }
      pending = { key, snapshot: current }
    },
    commit() {
      if (!pending) return
      past.push(pending.snapshot)
      trim()
      pending = null
      future.length = 0
    },
    cancel() {
      pending = null
    },
    undo(current) {
      const prev = past.pop()
      if (prev === undefined) return null
      future.push(current)
      return prev
    },
    redo(current) {
      const next = future.pop()
      if (next === undefined) return null
      past.push(current)
      trim()
      return next
    },
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    depth: () => past.length,
  }
}
