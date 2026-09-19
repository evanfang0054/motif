'use client'

import { useCallback, useEffect, useState } from 'react'
import { ProgressBar, ProgressCircle } from '@heroui/react'
import { api, type AdminOverview } from '@/lib/client'

/** 百分比展示：接口已保证 0/0 → 0，这里只负责保留一位小数 */
function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`
}

const SOURCE_LABEL: Record<string, string> = {
  opening_balance: '期初结存',
  signup_bonus: '注册赠送',
  invite_reward: '邀请奖励',
  order_paid: '订单支付',
  cdk_redeem: 'CDK 兑换',
  admin_adjust: '管理调整',
  generation_charge: '生成扣费',
  generation_refund: '失败/取消退回',
}

export default function AdminHomePage() {
  const [data, setData] = useState<AdminOverview | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setData(await api.adminOverview())
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : '加载失败')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (err) {
    return (
      <section className="admin-panel">
        <h1 className="admin-title">概览</h1>
        <div className="admin-alert-err" role="alert">{err}</div>
      </section>
    )
  }
  if (!data) {
    return (
      <section className="admin-panel">
        <h1 className="admin-title">概览</h1>
        <p className="admin-muted">加载中…</p>
      </section>
    )
  }

  const c = data.credits
  // 闭合恒等式：这一行让页面自己能证明「账目加得回来」
  const closed = c.granted + c.openingBalance + c.adjustedIn + c.refunded - c.adjustedOut - c.generatedCharged
  const ledgerDiff = c.balance - c.ledgerSum
  // 只有期初结存时（刚升级完、本系统还没产生任何流水），「发放 0 / 净消耗 0」看着像坏了 —— 明确说清楚
  const onlyOpening =
    c.openingBalance > 0 && c.granted === 0 && c.adjustedIn === 0 && c.adjustedOut === 0 && c.generatedCharged === 0 && c.refunded === 0

  const cdkTotal = data.cdks.unredeemed + data.cdks.redeemed + data.cdks.revoked
  const srcMax = Math.max(1, ...c.bySource.map((s) => Math.abs(s.net)))

  return (
    <>
    <section className="admin-panel">
      <h1 className="admin-title">概览</h1>

      <div className="admin-cards">
        <div className="admin-card" id="ov-users">
          <div className="admin-card-label">用户</div>
          <div className="admin-card-value">{data.users.total}</div>
          <div className="admin-card-sub">近 7 日新增 {data.users.newLast7d}</div>
        </div>

        <div className="admin-card" id="ov-credits">
          <div className="admin-card-label">额度（张）</div>
          <div className="admin-card-value">{c.balance}</div>
          <div className="admin-card-sub">
            净消耗 {c.netSpent}（扣 {c.generatedCharged} / 退 {c.refunded}）
          </div>
          <div className="admin-card-sub">
            发放 {c.granted} · 期初 {c.openingBalance} · 调整 +{c.adjustedIn}/-{c.adjustedOut}
          </div>
          {/* 对账口径常显：差额非 0 就是账目被旁路改过，不能藏在折叠区里 */}
          <div className={ledgerDiff === 0 ? 'admin-card-sub' : 'admin-card-sub admin-neg'}>
            对账：发放+期初+调整+退回−回收−扣费 = {closed}
            {ledgerDiff === 0 ? `（与存量 ${c.balance} 一致）` : `（与存量 ${c.balance} 相差 ${ledgerDiff}，账目可能被旁路修改）`}
          </div>
          {onlyOpening && (
            <div className="admin-card-sub">
              本系统尚未产生额度流水：当前存量 {c.openingBalance} 张全部来自升级时的期初结存
            </div>
          )}
          {c.bySource.map((s) => {
            const w = Math.round((Math.abs(s.net) / srcMax) * 100)
            return (
              <div className="admin-source-row" key={s.source}>
                <span className="admin-source-label">{SOURCE_LABEL[s.source] ?? s.source}</span>
                <span className="admin-source-track">
                  <span className={`admin-source-fill ${s.net < 0 ? 'is-neg' : 'is-pos'}`} style={{ width: `${w}%` }} />
                </span>
                <span className={`admin-source-value ${s.net < 0 ? 'admin-neg' : ''}`}>{s.net > 0 ? `+${s.net}` : s.net}</span>
              </div>
            )
          })}
        </div>

        <div className="admin-card" id="ov-generations">
          <div className="admin-card-label">生成轮次</div>
          <div className="admin-card-value">{data.generations.total}</div>
          <div className="admin-ring-row">
            <div className="admin-ring-wrap">
              <ProgressCircle aria-label="生成成功率" value={data.generations.successRate * 100} maxValue={100} className="admin-ring">
                <ProgressCircle.Track>
                  <ProgressCircle.TrackCircle />
                  <ProgressCircle.FillCircle />
                </ProgressCircle.Track>
              </ProgressCircle>
              <span className="admin-ring-text">{pct(data.generations.successRate)}</span>
            </div>
            <span className="admin-card-sub">分母为已结束轮次 {data.generations.terminal}</span>
          </div>
          {data.generations.topErrors.length > 0 ? (
            <ul className="admin-card-list">
              {data.generations.topErrors.map((e) => (
                <li key={e.error}>
                  <span className="admin-mono">{e.error}</span>
                  <span>{e.count}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="admin-card-sub">暂无失败记录</div>
          )}
        </div>

        <div className="admin-card" id="ov-orders">
          <div className="admin-card-label">订单</div>
          <div className="admin-card-value">{data.orders.paid}</div>
          <div className="admin-card-sub">待支付 {data.orders.pending}</div>
          <div className="admin-card-sub">已支付金额 HK$ {(data.orders.amountTotal / 100).toFixed(2)}</div>
        </div>

        <div className="admin-card" id="ov-cdks">
          <div className="admin-card-label">CDK</div>
          <div className="admin-card-value">{data.cdks.unredeemed}</div>
          {cdkTotal > 0 ? (
            <>
              <div className="admin-bar-row">
                <span className="admin-bar-label">未兑换</span>
                <ProgressBar aria-label="未兑换" value={data.cdks.unredeemed} maxValue={cdkTotal} className="admin-bar">
                  <ProgressBar.Track>
                    <ProgressBar.Fill />
                  </ProgressBar.Track>
                </ProgressBar>
                <span className="admin-bar-value">{data.cdks.unredeemed}</span>
              </div>
              <div className="admin-bar-row">
                <span className="admin-bar-label">已兑换</span>
                <ProgressBar aria-label="已兑换" value={data.cdks.redeemed} maxValue={cdkTotal} className="admin-bar">
                  <ProgressBar.Track>
                    <ProgressBar.Fill />
                  </ProgressBar.Track>
                </ProgressBar>
                <span className="admin-bar-value">{data.cdks.redeemed}</span>
              </div>
              <div className="admin-bar-row">
                <span className="admin-bar-label">已作废</span>
                <ProgressBar aria-label="已作废" value={data.cdks.revoked} maxValue={cdkTotal} className="admin-bar">
                  <ProgressBar.Track>
                    <ProgressBar.Fill />
                  </ProgressBar.Track>
                </ProgressBar>
                <span className="admin-bar-value">{data.cdks.revoked}</span>
              </div>
            </>
          ) : (
            <div className="admin-card-sub">暂无 CDK</div>
          )}
        </div>

        <div className="admin-card" id="ov-feedback">
          <div className="admin-card-label">反馈</div>
          <div className="admin-card-value">{data.feedback.pending}</div>
          <div className="admin-card-sub">待处理</div>
        </div>
      </div>
    </section>
    </>
  )
}
