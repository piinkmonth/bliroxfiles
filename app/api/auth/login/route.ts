import { cookies } from 'next/headers'
import { db, type UserRow } from '@/lib/db'
import {
  verifyPassword,
  createSession,
  clientIp,
  clientIpForStorage,
  userAgent,
  SESSION_COOKIE,
  cookieOptions,
} from '@/lib/auth'
import { audit } from '@/lib/audit'
import { ok, fail, route, jsonBody } from '@/lib/api'
import { reset as resetLimit } from '@/lib/ratelimit'
import { createChallenge } from '@/lib/twofactor'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface LoginBody {
  username?: string
  password?: string
}

export const POST = route(async (req: Request) => {
  const body = await jsonBody<LoginBody>(req)
  if (!body) return fail('Malformed request body')

  const username = (body.username ?? '').trim()
  const password = body.password ?? ''
  if (!username || !password) return fail('Username and password are required')

  const ip = await clientIp()
  const storedIp = await clientIpForStorage()

  const user = db().prepare(`SELECT * FROM users WHERE username = ?`).get(username) as
    | UserRow
    | undefined

  // Same message and roughly the same work either way, so the response does
  // not reveal whether the username exists.
  // Google-created accounts have an empty hash; verifyPassword returns false
  // for it, but the generic message would be baffling for someone who has
  // simply forgotten they never set one.
  if (user && !user.password_hash && user.google_sub) {
    return fail('This account signs in with Google — use the Google button', 403)
  }

  const valid = user ? verifyPassword(password, user.password_hash) : false
  if (!user || !valid) {
    audit({ action: 'auth.login_failed', targetType: 'user', targetId: username, ip: storedIp })
    return fail('Incorrect username or password', 401)
  }

  if (user.status === 'banned') {
    return fail('This account has been permanently closed.', 403)
  }
  if (user.status === 'suspended') {
    return fail(
      user.suspend_reason || 'This account is suspended pending review.',
      403,
    )
  }

  // A successful sign-in clears the failed-attempt budget for this bucket.
  resetLimit('login', `${ip ?? 'unknown'}:${username.toLowerCase()}`)

  /*
   * With two-factor on, the password alone earns a challenge rather than a
   * session. No cookie is set here — possession of the second factor is what
   * completes the sign-in, in /api/auth/2fa.
   */
  if (user.totp_enabled) {
    audit({
      actorId: user.id,
      actorName: user.username,
      action: 'auth.2fa_challenge',
      targetType: 'user',
      targetId: user.id,
      ip: storedIp,
    })
    return ok({
      requiresTwoFactor: true,
      challenge: createChallenge(user.id),
      username: user.username,
    })
  }

  const token = await createSession(user.id, storedIp, await userAgent())
  const jar = await cookies()
  jar.set(SESSION_COOKIE, token, cookieOptions())

  audit({
    actorId: user.id,
    actorName: user.username,
    action: 'auth.login',
    targetType: 'user',
    targetId: user.id,
    ip: storedIp,
  })

  return ok({ userId: user.id, username: user.username, role: user.role })
}, {
  limit: 'login',
  // Bucket per IP+username so an attacker cannot lock out someone else's
  // account by guessing at it from an unrelated address.
  limitKey: async (req) => {
    try {
      const body = await req.clone().json()
      return String(body?.username ?? '').toLowerCase().slice(0, 40)
    } catch {
      return ''
    }
  },
})
