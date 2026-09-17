import { executeMessage, type WorkerDeps } from './services'
import { getRuntime } from './context'

/**
 * 进程内生成队列 worker：
 * 云端排队执行——轮询租约队列，逐条执行生成消息。
 * 服务端重启后未完成消息保留在队列中，过期租约自动回收重排。
 * 本进程正在执行的消息不会被 requeue（防「执行中→被重排→取消全额退」的双退窗口）。
 */
interface WorkerState {
  deps: WorkerDeps
  timer: ReturnType<typeof setInterval> | null
  busy: boolean
}

const g = globalThis as unknown as { __motifWorker?: WorkerState }

// 真实生图单张可达 1–2 分钟，整批最长 30 分钟：租约需覆盖整批执行周期
const LEASE_MS = 1000 * 60 * 30

export function startWorker(): void {
  if (g.__motifWorker) return
  const { store, provider, dataDir } = getRuntime()
  const inFlight = new Set<string>()
  const state: WorkerState = {
    deps: { store, provider, dataDir, workerId: `worker-${process.pid}` },
    timer: null,
    busy: false,
  }
  g.__motifWorker = state

  const tick = async (): Promise<void> => {
    if (state.busy) return
    state.busy = true
    try {
      store.requeueExpiredLeases([...inFlight])
      // 每轮只认领一条，串行执行，模拟排队节奏
      const msg = store.leaseNextMessage(state.deps.workerId, LEASE_MS)
      if (msg) {
        inFlight.add(msg.id)
        try {
          await executeMessage(state.deps, msg.id)
        } finally {
          inFlight.delete(msg.id)
        }
      }
    } catch (e) {
      console.error('[motif] worker tick error:', e)
    } finally {
      state.busy = false
    }
  }

  state.timer = setInterval(() => void tick(), 600)
  if (state.timer.unref) state.timer.unref()
  console.log('[motif] 生成队列 worker 已启动')
}
