import { db, type InviteRow } from './db'
import { LIMITS } from './config'
import { newInviteCode } from './ids'
import { PUBLIC_ORIGIN } from './config'

export interface CreateInviteOpts {
  createdBy: string
  note?: string | null
  quotaBytes?: number
  maxUses?: number
  expiresInDays?: number | null
}

export function createInvite(opts: CreateInviteOpts): InviteRow {
  const code = newInviteCode()
  const now = Date.now()
  const quota = opts.quotaBytes ?? LIMITS.defaultQuotaBytes
  const maxUses = Math.max(1, Math.min(opts.maxUses ?? 1, 50))
  const expiresAt = opts.expiresInDays ? now + opts.expiresInDays * 86400_000 : null

  db()
    .prepare(
      `INSERT INTO invites (code, created_by, note, quota_bytes, max_uses, uses, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .run(code, opts.createdBy, opts.note ?? null, quota, maxUses, expiresAt, now)

  return db().prepare(`SELECT * FROM invites WHERE code = ?`).get(code) as InviteRow
}

export type InviteCheck =
  | { valid: true; invite: InviteRow }
  | { valid: false; reason: string }

export function checkInvite(code: string): InviteCheck {
  const invite = db()
    .prepare(`SELECT * FROM invites WHERE code = ?`)
    .get(code.trim().toLowerCase()) as InviteRow | undefined

  if (!invite) return { valid: false, reason: 'That invite code is not valid' }
  if (invite.revoked_at) return { valid: false, reason: 'That invite has been revoked' }
  if (invite.expires_at && invite.expires_at < Date.now()) {
    return { valid: false, reason: 'That invite has expired' }
  }
  if (invite.uses >= invite.max_uses) {
    return { valid: false, reason: 'That invite has already been used' }
  }
  return { valid: true, invite }
}

/**
 * Consume one use of an invite.
 *
 * The WHERE clause re-checks `uses < max_uses` so two people redeeming the
 * last use of a single-use invite at the same moment cannot both succeed —
 * SQLite serialises the writes and the loser gets 0 rows changed.
 */
export function redeemInvite(code: string): boolean {
  const result = db()
    .prepare(
      `UPDATE invites SET uses = uses + 1
       WHERE code = ?
         AND revoked_at IS NULL
         AND uses < max_uses
         AND (expires_at IS NULL OR expires_at > ?)`,
    )
    .run(code.trim().toLowerCase(), Date.now())
  return result.changes === 1
}

export function revokeInvite(code: string): void {
  db().prepare(`UPDATE invites SET revoked_at = ? WHERE code = ?`).run(Date.now(), code)
}

export function inviteUrl(code: string): string {
  return `${PUBLIC_ORIGIN}/join/${code}`
}

export interface InviteWithStats extends InviteRow {
  creator_name: string | null
  redeemed_by: string | null
}

export function listInvites(createdBy?: string): InviteWithStats[] {
  const where = createdBy ? `WHERE i.created_by = ?` : ''
  const params = createdBy ? [createdBy] : []

  return db()
    .prepare(
      `SELECT i.*,
              c.username AS creator_name,
              (SELECT GROUP_CONCAT(u.username, ', ')
                 FROM users u WHERE u.invite_code = i.code) AS redeemed_by
       FROM invites i
       LEFT JOIN users c ON c.id = i.created_by
       ${where}
       ORDER BY i.created_at DESC
       LIMIT 500`,
    )
    .all(...params) as InviteWithStats[]
}

/** An invite is spent when it can never be redeemed again. */
export function inviteState(invite: InviteRow): 'active' | 'used' | 'expired' | 'revoked' {
  if (invite.revoked_at) return 'revoked'
  if (invite.expires_at && invite.expires_at < Date.now()) return 'expired'
  if (invite.uses >= invite.max_uses) return 'used'
  return 'active'
}
