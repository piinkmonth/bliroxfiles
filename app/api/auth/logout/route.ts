import { cookies } from 'next/headers'
import { destroySession, currentUser, SESSION_COOKIE } from '@/lib/auth'
import { audit } from '@/lib/audit'
import { ok, route } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const POST = route(async () => {
  const user = await currentUser()
  const jar = await cookies()
  const token = jar.get(SESSION_COOKIE)?.value

  if (token) destroySession(token)
  jar.delete(SESSION_COOKIE)

  if (user) {
    audit({
      actorId: user.id,
      actorName: user.username,
      action: 'auth.logout',
      targetType: 'user',
      targetId: user.id,
    })
  }

  return ok({ loggedOut: true })
})
