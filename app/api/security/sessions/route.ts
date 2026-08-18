import { requireUser, SESSION_COOKIE } from '@/lib/auth'
import { cookies } from 'next/headers'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { ok, fail, route, jsonBody } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Turn the geo guard on or off for the caller's own account. */
export const PATCH = route(async (req: Request) => {
  const user = await requireUser()
  const body = await jsonBody<{ geoGuard?: boolean }>(req)
  if (typeof body?.geoGuard !== 'boolean') return fail('geoGuard must be true or false')

  db().prepare(`UPDATE users SET geo_guard = ? WHERE id = ?`).run(body.geoGuard ? 1 : 0, user.id)

  audit({
    actorId: user.id,
    actorName: user.username,
    action: body.geoGuard ? 'security.geo_guard_on' : 'security.geo_guard_off',
    targetType: 'user',
    targetId: user.id,
  })

  return ok({ geoGuard: body.geoGuard })
})

/**
 * Revoke a session.
 *
 * `?token=` revokes one; omitting it revokes every session except the one
 * making the request, which is the "sign out everywhere else" button. The
 * DELETE is scoped by user_id so a token belonging to somebody else is a
 * no-op rather than an error — there is nothing to tell the caller about
 * someone else's session.
 */
export const DELETE = route(async (req: Request) => {
  const user = await requireUser()
  const target = new URL(req.url).searchParams.get('token')
  const current = (await cookies()).get(SESSION_COOKIE)?.value ?? ''

  if (target) {
    if (target === current) return fail('That is the session you are using — sign out instead')
    const res = db()
      .prepare(`DELETE FROM sessions WHERE token = ? AND user_id = ?`)
      .run(target, user.id)

    audit({
      actorId: user.id,
      actorName: user.username,
      action: 'security.session_revoked',
      targetType: 'user',
      targetId: user.id,
      detail: { count: res.changes },
    })
    return ok({ revoked: res.changes })
  }

  const res = db()
    .prepare(`DELETE FROM sessions WHERE user_id = ? AND token != ?`)
    .run(user.id, current)

  audit({
    actorId: user.id,
    actorName: user.username,
    action: 'security.sessions_revoked_all',
    targetType: 'user',
    targetId: user.id,
    detail: { count: res.changes },
  })

  return ok({ revoked: res.changes })
})
