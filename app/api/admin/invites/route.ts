import { requireRole } from '@/lib/auth'
import { LIMITS, GB } from '@/lib/config'
import { createInvite, inviteUrl } from '@/lib/invites'
import { diskState } from '@/lib/storage'
import { audit } from '@/lib/audit'
import { ok, fail, route, jsonBody } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface CreateBody {
  note?: string
  quotaGb?: number
  maxUses?: number
  expiresInDays?: number | null
}

export const POST = route(async (req: Request) => {
  const admin = requireRole('admin')
  const body = await jsonBody<CreateBody>(req)
  if (!body) return fail('Malformed request body')

  const quotaBytes = body.quotaGb ? Math.round(body.quotaGb * GB) : LIMITS.defaultQuotaBytes
  if (quotaBytes <= 0) return fail('Quota must be positive')

  // Quota is overcommitted by design, so this is a warning rather than a
  // refusal — but silently handing out allocation on a full disk is how you
  // find out at someone else's upload.
  const disk = diskState()
  const warning =
    disk.freeBytes < 30 * GB
      ? 'Heads up: the disk is nearly full. This account may not be able to upload.'
      : null

  const invite = createInvite({
    createdBy: admin.id,
    note: body.note?.slice(0, 200) ?? null,
    quotaBytes,
    maxUses: body.maxUses,
    expiresInDays: body.expiresInDays ?? null,
  })

  audit({
    actorId: admin.id,
    actorName: admin.username,
    action: 'invite.create',
    targetType: 'invite',
    targetId: invite.code,
    detail: { quotaBytes, maxUses: invite.max_uses, note: invite.note },
  })

  return ok({ invite: { ...invite, url: inviteUrl(invite.code) }, warning })
})
