import { redirect } from 'next/navigation'
import { currentUser, hasRole } from '@/lib/auth'
import { listInvites, inviteState } from '@/lib/invites'
import { LIMITS, GB } from '@/lib/config'
import { InvitesClient } from './InvitesClient'

export const dynamic = 'force-dynamic'

export default function InvitesPage() {
  const user = currentUser()
  if (!user || !hasRole(user, 'admin')) redirect('/admin')

  const invites = listInvites().map((i) => ({
    code: i.code,
    note: i.note,
    quotaBytes: i.quota_bytes,
    maxUses: i.max_uses,
    uses: i.uses,
    expiresAt: i.expires_at,
    createdAt: i.created_at,
    creator: i.creator_name,
    redeemedBy: i.redeemed_by,
    state: inviteState(i),
  }))

  return <InvitesClient invites={invites} defaultQuotaGb={LIMITS.defaultQuotaBytes / GB} />
}
