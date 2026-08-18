import { requireUser } from '@/lib/auth'
import { ok, fail, route } from '@/lib/api'
import { revokeToken } from '@/lib/apitokens'
import { audit } from '@/lib/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface Ctx {
  params: Promise<{ id: string }>
}

/**
 * DELETE /api/profile/tokens/:id — revoke a token.
 *
 * Revocation is immediate: verifyToken rejects a revoked token on the next
 * request. The row is kept (not deleted) so the audit trail and last-used
 * record survive.
 */
export const DELETE = route(async (_req: Request, { params }: Ctx) => {
  const { id } = await params
  const user = await requireUser()

  if (!revokeToken(user.id, id)) {
    return fail('Token not found', 404)
  }

  audit({
    actorId: user.id,
    actorName: user.username,
    action: 'token.revoke',
    targetType: 'token',
    targetId: id,
  })

  return ok({ revoked: true })
})
