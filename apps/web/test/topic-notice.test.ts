import { describe, expect, it } from 'vitest'
import type { CanvasImage, Message, Topic, TopicDetail } from '@motif/core'
import { isBusyStatus, leftBusy, planTopicNotices, terminalNotice } from '@/lib/topic-notice'

function makeTopic(over: Partial<Topic> = {}): Topic {
  return {
    id: 'top_1',
    userId: 'usr_1',
    title: '海报',
    status: 'idle',
    activeMessageId: null,
    activePrompt: null,
    createdAt: '2026-09-21T00:00:00.000Z',
    updatedAt: '2026-09-21T00:00:00.000Z',
    ...over,
  }
}

function makeMessage(over: Partial<Message> = {}): Message {
  return {
    id: 'msg_1',
    topicId: 'top_1',
    userId: 'usr_1',
    prompt: '画一只猫',
    finalPrompt: '画一只猫',
    size: '1024x1024',
    requestedCount: 4,
    enhancePrompt: false,
    referenceIds: [],
    slotPlan: [],
    status: 'completed',
    workerId: null,
    lockedAt: null,
    leaseToken: null,
    leaseExpiresAt: null,
    attempts: 1,
    error: null,
    createdAt: '2026-09-21T00:00:00.000Z',
    ...over,
  }
}

function makeImage(over: Partial<CanvasImage> = {}): CanvasImage {
  return {
    id: 'cimg_1',
    topicId: 'top_1',
    userId: 'usr_1',
    origin: 'generated',
    serial: 1,
    name: '图片 1',
    src: '/api/canvas-images/cimg_1',
    imageKey: 'k1.png',
    mimeType: 'image/png',
    bytes: 1,
    width: 1024,
    height: 1024,
    canvasX: 0,
    canvasY: 0,
    canvasWidth: 240,
    canvasHeight: 240,
    updatedAt: '2026-09-21T00:00:00.000Z',
    messageId: 'msg_1',
    createdAt: '2026-09-21T00:00:00.000Z',
    ...over,
  }
}

function makeDetail(over: Partial<TopicDetail> = {}): TopicDetail {
  return {
    topic: makeTopic(),
    messages: [makeMessage()],
    canvasImages: [makeImage()],
    messageReferences: [],
    ...over,
  }
}

describe('isBusyStatus / leftBusy', () => {
  it('三种进行态算「在跑」，其余一律不算', () => {
    for (const s of ['pending', 'running', 'canceling']) expect(isBusyStatus(s)).toBe(true)
    for (const s of ['idle', 'completed', 'failed', 'canceled', '', undefined]) expect(isBusyStatus(s)).toBe(false)
  })

  it('从「在跑」落到「不在跑」才算一次结束', () => {
    expect(leftBusy('pending', 'idle')).toBe(true)
    expect(leftBusy('running', 'idle')).toBe(true)
    expect(leftBusy('canceling', 'idle')).toBe(true)
    // topic 本身不写终态，但若将来写了，也必须算「结束」（不能在改服务端时把回执吞掉）
    expect(leftBusy('pending', 'completed')).toBe(true)
  })

  it('第一次见到的任务不提示（首屏的历史终态不能被当成新闻播一遍）', () => {
    expect(leftBusy(undefined, 'idle')).toBe(false)
    expect(leftBusy(undefined, 'pending')).toBe(false)
  })

  it('状态没变或从空闲起步都不算结束', () => {
    expect(leftBusy('pending', 'pending')).toBe(false)
    expect(leftBusy('idle', 'pending')).toBe(false)
    expect(leftBusy('idle', 'idle')).toBe(false)
  })
})

describe('terminalNotice 文案与判定', () => {
  it('完成：成功态、无前缀', () => {
    const d = makeDetail({ topic: makeTopic({ status: 'idle' }), messages: [makeMessage({ status: 'completed' })] })
    expect(terminalNotice(d)).toEqual({ tone: 'success', message: '生成完成 ✓' })
  })

  it('非当前任务：前缀任务名', () => {
    const d = makeDetail({
      topic: makeTopic({ title: '商品图', status: 'idle' }),
      messages: [makeMessage({ status: 'completed' })],
    })
    expect(terminalNotice(d, { title: '商品图' })?.message).toBe('任务「商品图」生成完成 ✓')
  })

  it('失败：带原因，6 秒', () => {
    const d = makeDetail({ messages: [makeMessage({ status: 'failed', error: '网关 502' })] })
    expect(terminalNotice(d)).toEqual({ tone: 'danger', message: '生成失败：网关 502。', timeoutMs: 6000 })
  })

  it('失败：原因缺失时不编造，写「未知原因」', () => {
    const d = makeDetail({ messages: [makeMessage({ status: 'failed', error: null })] })
    expect(terminalNotice(d)?.message).toBe('生成失败：未知原因。')
  })

  it('取消：按「请求张数 − 已交付张数」报退额张数', () => {
    const d = makeDetail({
      messages: [makeMessage({ status: 'canceled', requestedCount: 4 })],
      canvasImages: [makeImage({ id: 'cimg_1', serial: 1 })],
    })
    expect(terminalNotice(d)).toEqual({
      tone: 'info',
      message: '任务已取消，未完成的 3 张额度已退回。',
      timeoutMs: 6000,
    })
  })

  it('取消但一张没少（全交付）：不提示', () => {
    const d = makeDetail({
      messages: [makeMessage({ status: 'canceled', requestedCount: 2 })],
      canvasImages: [
        makeImage({ id: 'cimg_1', serial: 1 }),
        makeImage({ id: 'cimg_2', serial: 2 }),
      ],
    })
    expect(terminalNotice(d)).toBeNull()
  })

  it('进行中（排队/生成中）不提示', () => {
    for (const status of ['queued', 'running', 'canceling'] as const) {
      const d = makeDetail({ messages: [makeMessage({ status })] })
      expect(terminalNotice(d)).toBeNull()
    }
  })

  it('messages 为空：返回 null，不读 undefined', () => {
    const d = makeDetail({ messages: [], canvasImages: [] })
    expect(terminalNotice(d)).toBeNull()
    expect(terminalNotice(d, { title: '空任务' })).toBeNull()
  })

  it('activeMessageId 已置空时回退到最后一条（终态的真实形状）', () => {
    const d = makeDetail({
      topic: makeTopic({ activeMessageId: null }),
      messages: [
        makeMessage({ id: 'msg_1', status: 'completed' }),
        makeMessage({ id: 'msg_2', status: 'failed', error: '超时' }),
      ],
    })
    expect(terminalNotice(d)?.message).toBe('生成失败：超时。')
  })

  it('带任务名时取消文案不把「任务」说两遍', () => {
    const d = makeDetail({
      topic: makeTopic({ title: '海报' }),
      messages: [makeMessage({ status: 'canceled', requestedCount: 4 })],
      canvasImages: [makeImage({ id: 'cimg_1', serial: 1 })],
    })
    expect(terminalNotice(d, { title: '海报' })?.message).toBe('任务「海报」已取消，未完成的 3 张额度已退回。')
  })

  it('带任务名时失败文案同样带前缀（不重复名词）', () => {
    const d = makeDetail({ messages: [makeMessage({ status: 'failed', error: '网关 502' })] })
    expect(terminalNotice(d, { title: '商品图' })?.message).toBe('任务「商品图」生成失败：网关 502。')
  })
})

describe('planTopicNotices 列表级回执判定', () => {
  const row = (id: string, status: string, title = id) => ({ id, status, title })

  it('首屏（没有上一份快照）不提示任何历史终态', () => {
    const plan = planTopicNotices({
      prev: new Map(),
      topics: [row('a', 'idle'), row('b', 'completed')],
      activeId: null,
    })
    expect(plan.finished).toEqual([])
    expect(plan.next.get('a')).toBe('idle')
  })

  it('非当前任务从「在跑」落到「不在跑」⇒ 提示它', () => {
    const plan = planTopicNotices({
      prev: new Map([['a', 'pending'], ['b', 'idle']]),
      topics: [row('a', 'idle', '海报'), row('b', 'idle')],
      activeId: 'b',
    })
    expect(plan.finished).toEqual([{ id: 'a', title: '海报' }])
  })

  it('同一次迁移只提示一次（把 next 回灌再算就是空的）', () => {
    const prev = new Map([['a', 'pending']])
    const first = planTopicNotices({ prev, topics: [row('a', 'idle')], activeId: null })
    const second = planTopicNotices({ prev: first.next, topics: [row('a', 'idle')], activeId: null })
    expect(first.finished).toHaveLength(1)
    expect(second.finished).toEqual([])
  })

  it('当前任务被排除（它的迁移由 watchTopic 那条路径负责，避免双份）', () => {
    const plan = planTopicNotices({
      prev: new Map([['a', 'pending']]),
      topics: [row('a', 'idle')],
      activeId: 'a',
    })
    expect(plan.finished).toEqual([])
  })

  it('并发两次调用不双报（第二次读到已更新的快照）', () => {
    const prev = new Map([['a', 'running']])
    const topics = [row('a', 'idle')]
    const a = planTopicNotices({ prev, topics, activeId: null })
    const b = planTopicNotices({ prev: a.next, topics, activeId: null })
    expect(a.finished).toHaveLength(1)
    expect(b.finished).toHaveLength(0)
  })

  it('仍在跑、或从未在跑，都不提示', () => {
    const plan = planTopicNotices({
      prev: new Map([['a', 'pending'], ['b', 'idle']]),
      topics: [row('a', 'running'), row('b', 'pending')],
      activeId: null,
    })
    expect(plan.finished).toEqual([])
  })
})
