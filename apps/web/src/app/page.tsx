import { cookies } from 'next/headers'
import { getRuntime } from '@/server/context'
import { SESSION_COOKIE } from '@/server/auth'
import { Landing } from '@/components/landing/Landing'
import { Workspace } from '@/components/workspace/Workspace'
import type { User } from '@motif/core'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const jar = await cookies()
  const token = jar.get(SESSION_COOKIE)?.value
  let user: User | null = null
  if (token) {
    user = getRuntime().store.getUserBySession(token)
  }
  return user ? <Workspace initialUser={user} /> : <Landing />
}
