import crypto from 'node:crypto'
import { db } from './db'

/**
 * Pending two-factor sign-ins.
 *
 * Between the password step and the code step the user is authenticated but
 * has no session. That intermediate state is a database row rather than a
 * cookie or a JWT so it can be invalidated centrally and cannot be replayed:
 * it is deleted the moment it is read.
 */

const TTL_MS = 5 * 60_000

let ready = false
function ensureTable() {
  if (ready) return
  db().exec(`
    CREATE TABLE IF NOT EXISTS twofactor_challenges (
      token      TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_2fa_expiry ON twofactor_challenges(expires_at);
  `)
  ready = true
}

export function createChallenge(userId: string): string {
  ensureTable()
  const token = crypto.randomBytes(32).toString('base64url')
  const now = Date.now()
  db()
    .prepare(
      `INSERT INTO twofactor_challenges (token, user_id, created_at, expires_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(token, userId, now, now + TTL_MS)
  return token
}

/** Read and consume. Single-use by construction. */
export function takeChallenge(token: string): { user_id: string } | null {
  ensureTable()
  const row = db()
    .prepare(`SELECT user_id, expires_at FROM twofactor_challenges WHERE token = ?`)
    .get(token) as { user_id: string; expires_at: number } | undefined

  db().prepare(`DELETE FROM twofactor_challenges WHERE token = ?`).run(token)

  if (!row || row.expires_at < Date.now()) return null
  return { user_id: row.user_id }
}

export function sweepChallenges(): number {
  ensureTable()
  return db().prepare(`DELETE FROM twofactor_challenges WHERE expires_at < ?`).run(Date.now()).changes
}
