import { requireRole, destroyAllSessions } from '@/lib/auth'
import { db, type UserRow } from '@/lib/db'
import { GB } from '@/lib/config'
import { audit } from '@/lib/audit'
import { ok, fail, route, jsonBody } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface PatchBody {
  status?: 'active' | 'suspended' | 'banned'
  reason?: string
  quotaGb?: number
  role?: 'user' | 'mod' | 'admin'
  /** Staff vouching for the account — shows a check next to their name. */
  verified?: boolean
  verifiedNote?: string
}

export const PATCH = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params
  const admin = await requireRole('admin')

  const target = db().prepare(`SELECT * FROM users WHERE id = ?`).get(id) as
    | UserRow
    | undefined
  if (!target) return fail('User not found', 404)

  const body = await jsonBody<PatchBody>(req)
  if (!body) return fail('Malformed request body')

  // An admin who locks themselves out has no recovery path short of the CLI.
  if (target.id === admin.id && (body.status || body.role)) {
    return fail('You cannot change your own status or role', 400)
  }

  const updates: string[] = []
  const values: unknown[] = []
  const now = Date.now()

  if (body.status) {
    if (!['active', 'suspended', 'banned'].includes(body.status)) return fail('Unknown status')
    updates.push('status = ?', 'suspended_at = ?', 'suspend_reason = ?')
    values.push(
      body.status,
      body.status === 'active' ? null : now,
      body.status === 'active' ? null : (body.reason ?? null),
    )
  }

  if (body.quotaGb !== undefined) {
    const bytes = Math.round(body.quotaGb * GB)
    if (bytes < 0) return fail('Quota cannot be negative')
    // Lowering quota below current usage is allowed — it blocks new uploads
    // without deleting anything the user already has.
    updates.push('quota_bytes = ?')
    values.push(bytes)
  }

  if (body.role) {
    if (!['user', 'mod', 'admin'].includes(body.role)) return fail('Unknown role')
    updates.push('role = ?')
    values.push(body.role)
  }

  if (body.verified !== undefined) {
    if (body.verified) {
      updates.push('account_verified_at = ?', 'account_verified_by = ?', 'account_verified_note = ?')
      values.push(now, admin.id, (body.verifiedNote ?? '').slice(0, 120) || null)
    } else {
      updates.push('account_verified_at = ?', 'account_verified_by = ?', 'account_verified_note = ?')
      values.push(null, null, null)
    }
  }

  if (updates.length === 0) return fail('Nothing to update')

  values.push(target.id)
  db().prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values)

  // A suspended account with a live session is still a logged-in account.
  if (body.status && body.status !== 'active') {
    destroyAllSessions(target.id)
  }

  audit({
    actorId: admin.id,
    actorName: admin.username,
    action: 'user.update',
    targetType: 'user',
    targetId: target.id,
    detail: { username: target.username, ...body },
  })

  return ok({ updated: true })
})
