import { requireUser, clientIpForStorage } from '@/lib/auth'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { ok, fail, route } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Unlink Google from the signed-in account.
 *
 * Refused when there is no password set, because Google would be the only way
 * in — unlinking would leave the account permanently unreachable, with no
 * password reset to fall back on.
 */
export const DELETE = route(async () => {
  const user = requireUser()

  if (!user.google_sub) return fail('This account is not linked to Google', 409)

  if (!user.password_hash) {
    return fail(
      'Set a password first — Google is currently the only way into this account, ' +
        'and unlinking it would lock you out for good.',
      409,
    )
  }

  db()
    .prepare(
      `UPDATE users SET google_sub = NULL, google_email = NULL, google_linked_at = NULL
       WHERE id = ?`,
    )
    .run(user.id)

  audit({
    actorId: user.id,
    actorName: user.username,
    action: 'auth.google_unlink',
    targetType: 'user',
    targetId: user.id,
    ip: clientIpForStorage(),
  })

  return ok({ unlinked: true })
})
