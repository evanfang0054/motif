import { NextRequest, NextResponse } from 'next/server'
import { requireRoot, writeAudit } from '@/server/admin'
import { getRuntime } from '@/server/context'
import { jsonError, readJson } from '@/server/http'
import { ServiceError, sendTestMail } from '@/server/services'

/** 测试发送（root 独占 + 频控）：用当前生效 mailer 真实投递一封；成败均写审计（记原因摘要，不记密钥） */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const actor = requireRoot(req)
    const { to } = await readJson<{ to?: string }>(req)
    if (!to) throw new ServiceError(400, '请填写测试收件邮箱。')
    try {
      const r = await sendTestMail(getRuntime().mailer, to)
      writeAudit({ actorId: actor.id, action: 'mailer.test', targetType: 'settings', detail: { via: r.via, to, ok: true } })
      return NextResponse.json(r)
    } catch (e) {
      // 失败（频控/凭据错误）恰是最需留痕的场景：记审计后再把错误交回 jsonError 透传页面
      writeAudit({
        actorId: actor.id,
        action: 'mailer.test',
        targetType: 'settings',
        detail: { to, ok: false, reason: e instanceof Error ? e.message.slice(0, 200) : 'unknown' },
      })
      throw e
    }
  } catch (e) {
    return jsonError(e)
  }
}
