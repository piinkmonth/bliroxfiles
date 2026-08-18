import { cookies } from 'next/headers'
import { requireUser, hashPassword, verifyPassword, destroyAllSessions, createSession, clientIpForStorage, userAgent, SESSION_COOKIE, cookieOptions } from '@/lib/auth'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { ok, fail, route, jsonBody } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface Body {
  currentPassword?: string
  newPassword?: string
}

/**
 * Set or change the account password.
 *
 * Accounts created through Google have no password at all, so `currentPassword`
 * is only required when one already exists. Changing it drops every other
 * session — a password change is what someone does when they think a session is
 * compromised, and leaving the others alive defeats the point.
 */
export const POST = route(async (req: Request) => {
  const user = requireUser()
  const body = await jsonBody<Body>(req)
  if (!body?.newPassword) return fail('A new password is required')

  const next = body.newPassword
  if (next.length < 10) return fail('Password must be at least 10 characters')
  if (next.length > 200) return fail('Password is too long')
  const weak = ['password', '1234567890', 'qwertyuiop', 'letmein123']
  if (weak.some((w) => next.toLowerCase().includes(w))) {
    return fail('That password is too predictable — try a passphrase')
  }

  const hasPassword = !!user.password_hash
  if (hasPassword) {
    if (!body.currentPassword) return fail('Enter your current password')
    if (!verifyPassword(body.currentPassword, user.password_hash)) {
      return fail('That is not your current password', 403)
    }
  }

  db().prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hashPassword(next), user.id)

  // Invalidate everything, then re-issue for this browser so the person doing
  // the change is not signed out of the page they are standing on.
  destroyAllSessions(user.id)
  const token = createSession(user.id, clientIpForStorage(), userAgent())
  cookies().set(SESSION_COOKIE, token, cookieOptions())

  audit({
    actorId: user.id,
    actorName: user.username,
    action: hasPassword ? 'auth.password_change' : 'auth.password_set',
    targetType: 'user',
    targetId: user.id,
    ip: clientIpForStorage(),
    detail: { otherSessionsEnded: true },
  })

  return ok({ updated: true })
})
