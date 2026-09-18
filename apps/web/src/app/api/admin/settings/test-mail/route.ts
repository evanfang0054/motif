import { NextRequest, NextResponse } from 'next/server'
import { requireRoot, writeAudit } from '@/server/admin'
import { getRuntime } from '@/server/context'
import { jsonError, readJson } from '@/server/http'
import { ServiceError, sendTestMail } from '@/server/services'

/** 测试发送（root 独占 + 频控）：用当前生效 mailer 真实投递一封；审计记操作与收件人（非密钥） */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const actor = requireRoot(req)
    const { to } = await readJson<{ to?: string }>(req)
    if (!to) throw new ServiceError(400, '请填写测试收件邮箱。')
    const r = await sendTestMail(getRuntime().mailer, to)
    writeAudit({ actorId: actor.id, action: 'mailer.test', targetType: 'settings', detail: { via: r.via, to } })
    return NextResponse.json(r)
  } catch (e) {
    return jsonError(e)
  }
}
