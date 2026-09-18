import type { MotifStore } from '@motif/db'
import { executeMessage, type WorkerDeps } from './services'
import { getRuntime } from './context'

/**
 * 进程内生成队列 worker：
 * 云端排队执行——轮询租约队列，逐条执行生成消息。
 * 服务端重启后未完成消息保留在队列中，过期租约自动回收重排。
 * 本进程正在执行的消息不会被 requeue（防「执行中→被重排→取消全额退」的双退窗口）。
 *
 * ⚠️ 这里**刻意不缓存 provider**：provider 由配置构造，而配置可以在管理后台热改。
 * 缓存它会让「改了生图密钥、设置页显示成功、实际仍用旧网关」这种静默失效发生 ——
 * 而 worker 是唯一真正调用生图网关的执行者，缓存它就等于热重载在最后一公里断掉。
 * store 与 dataDir 不随配置变化（数据库位置是只读引导参数），照旧持有。
 */
export interface WorkerState {
  store: MotifStore
  dataDir: string
  workerId: string
  busy: boolean
  timer: ReturnType<typeof setInterval> | null
  inFlight: Set<string>
}

const g = globalThis as unknown as { __motifWorker?: WorkerState }

// 真实生图单张可达 1–2 分钟，整批最长 30 分钟：租约需覆盖整批执行周期
const LEASE_MS = 1000 * 60 * 30

/** 每轮现取当前 runtime 的 provider —— 配置热重载必须能贯通到真正的执行侧 */
export function resolveWorkerDeps(state: WorkerState): WorkerDeps {
  return {
    store: state.store,
    provider: getRuntime().provider,
    dataDir: state.dataDir,
    workerId: state.workerId,
  }
}

/**
 * 单轮：认领并**完整**执行一条消息。
 * 一次 tick 只认领一条、跑完再取下一个 provider，因此「同一批次中途不换网关」天然成立。
 * 导出以便测试直接驱动，不必等 600ms 定时器。
 */
export async function runWorkerTick(state: WorkerState): Promise<void> {
  if (state.busy) return
  state.busy = true
  try {
    state.store.requeueExpiredLeases([...state.inFlight])
    // 每轮只认领一条，串行执行，模拟排队节奏
    const msg = state.store.leaseNextMessage(state.workerId, LEASE_MS)
    if (msg) {
      state.inFlight.add(msg.id)
      try {
        await executeMessage(resolveWorkerDeps(state), msg.id)
      } finally {
        state.inFlight.delete(msg.id)
      }
    }
  } catch (e) {
    console.error('[motif] worker tick error:', e)
  } finally {
    state.busy = false
  }
}

export function startWorker(): void {
  if (g.__motifWorker) return
  const { store, dataDir } = getRuntime()
  const state: WorkerState = {
    store,
    dataDir,
    workerId: `worker-${process.pid}`,
    busy: false,
    timer: null,
    inFlight: new Set<string>(),
  }
  g.__motifWorker = state

  state.timer = setInterval(() => void runWorkerTick(state), 600)
  if (state.timer.unref) state.timer.unref()
  // 启动即执行一轮：进程重启后立即恢复历史 queued 消息、重排过期租约，不等首个 600ms
  void runWorkerTick(state)
  console.log('[motif] 生成队列 worker 已启动')
}

/** 停止 worker（测试与未来优雅停机用） */
export function stopWorker(): void {
  const state = g.__motifWorker
  if (!state) return
  if (state.timer) clearInterval(state.timer)
  g.__motifWorker = undefined
}
