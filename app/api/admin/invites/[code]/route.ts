import { requireRole } from '@/lib/auth'
import { revokeInvite } from '@/lib/invites'
import { audit } from '@/lib/audit'
import { ok, route } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const DELETE = route(async (_req: Request, { params }: { params: { code: string } }) => {
  const admin = requireRole('admin')
  revokeInvite(params.code)

  audit({
    actorId: admin.id,
    actorName: admin.username,
    action: 'invite.revoke',
    targetType: 'invite',
    targetId: params.code,
  })

  return ok({ revoked: true })
})
