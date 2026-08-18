import { headers } from 'next/headers'
import { db } from './db'
import { encryptIp } from './crypto'

export interface AuditEntry {
  actorId?: string | null
  actorName?: string | null
  action: string
  targetType?: string | null
  targetId?: string | null
  /**
   * Already-encrypted address. Omit it and the request's own is captured and
   * encrypted — which is what almost every caller wants.
   */
  ip?: string | null
  /** Two-letter country. Omit to capture it from the request. */
  country?: string | null
  detail?: unknown
}

/**
 * Request origin, for entries that do not supply their own.
 *
 * `headers()` throws outside a request scope, which is a legitimate place to
 * write an audit entry from — a maintenance sweep, say. Failing to resolve the
 * origin must not cost the entry, so it degrades to nulls.
 */
function requestOrigin(): { ip: string | null; country: string | null } {
  try {
    const h = headers()
    const ip =
      h.get('cf-connecting-ip') ?? h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
    const code = h.get('cf-ipcountry')
    const country =
      code && code !== 'XX' && code !== 'T1' && /^[A-Z]{2}$/.test(code) ? code : null
    return { ip, country }
  } catch {
    return { ip: null, country: null }
  }
}

/**
 * Append to the audit trail. Never throws — an audit failure must not take
 * down the operation it is recording, but it does get surfaced on stderr.
 *
 * The address is stored under AES-GCM, never in the clear. Reading the log
 * therefore does not expose anyone's IP: the admin view shows the country
 * instead, and the plaintext is recoverable only where the law demands it (see
 * lib/crypto.ts on § 2258A). Callers that already hold an encrypted value pass
 * it; everyone else lets this capture and encrypt the request's own.
 */
export function audit(entry: AuditEntry): void {
  try {
    const needsCapture = entry.ip === undefined || entry.country === undefined
    const captured = needsCapture ? requestOrigin() : { ip: null, country: null }

    db()
      .prepare(
        `INSERT INTO audit_log
           (actor_id, actor_name, action, target_type, target_id, ip, country, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.actorId ?? null,
        entry.actorName ?? null,
        entry.action,
        entry.targetType ?? null,
        entry.targetId ?? null,
        entry.ip === undefined ? encryptIp(captured.ip) : entry.ip,
        entry.country === undefined ? captured.country : entry.country,
        entry.detail === undefined ? null : JSON.stringify(entry.detail),
        Date.now(),
      )
  } catch (err) {
    console.error('[audit] failed to record', entry.action, err)
  }
}

export interface AuditRow {
  id: number
  actor_id: string | null
  actor_name: string | null
  action: string
  target_type: string | null
  target_id: string | null
  country: string | null
  detail: string | null
  created_at: number
}

/**
 * Audit entries for display.
 *
 * `ip` is deliberately absent from the projection rather than merely unread by
 * the caller. A column that is never selected cannot be leaked into a log line,
 * an error page, or a future template by accident.
 */
const DISPLAY_COLUMNS = `id, actor_id, actor_name, action, target_type, target_id, country, detail, created_at`

export function recentAudit(limit = 100, offset = 0): AuditRow[] {
  return db()
    .prepare(
      `SELECT ${DISPLAY_COLUMNS} FROM audit_log
       ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as AuditRow[]
}

export function auditForTarget(targetType: string, targetId: string): AuditRow[] {
  return db()
    .prepare(
      `SELECT ${DISPLAY_COLUMNS} FROM audit_log WHERE target_type = ? AND target_id = ?
       ORDER BY created_at DESC, id DESC LIMIT 200`,
    )
    .all(targetType, targetId) as AuditRow[]
}
