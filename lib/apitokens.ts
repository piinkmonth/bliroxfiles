import crypto from 'node:crypto'
import { db, type ApiScope, type ApiTokenRow, type UserRow } from './db'
import { newId, newApiTokenSecret } from './ids'
import { clientIpForStorage } from './auth'

/**
 * api token store.
 *
 * tokens authenticate the public API (api.example.com). stored hashed, never in
 * the clear: the raw secret is shown once at creation and never again. a lookup
 * hashes what u present and matches token_hash, so a db leak hands over nothing
 * usable. table lives in lib/db.ts.
 */

export const ALL_SCOPES: ApiScope[] = ['read', 'write', 'delete']

export function isScope(v: unknown): v is ApiScope {
  return typeof v === 'string' && (ALL_SCOPES as string[]).includes(v)
}

/** Parse a stored csv scope string into a validated set. */
export function parseScopes(csv: string): Set<ApiScope> {
  const out = new Set<ApiScope>()
  for (const part of csv.split(',')) {
    const s = part.trim()
    if (isScope(s)) out.add(s)
  }
  return out
}

/** sha256 of the raw token, hex — what actually lives in the database. */
function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex')
}

export interface CreatedToken {
  /** The raw secret. Shown once, never recoverable. */
  token: string
  row: ApiTokenRow
}

/**
 * Mint a token for a user. Returns the raw secret alongside the stored row so
 * the caller can present it a single time; only the hash is persisted.
 */
export function createToken(
  userId: string,
  name: string,
  scopes: ApiScope[],
  expiresAt?: number | null,
): CreatedToken {
  const token = newApiTokenSecret()
  const id = newId()
  const now = Date.now()
  // A dedupe of scopes in the caller's given order, so the stored csv is stable.
  const scopeCsv = ALL_SCOPES.filter((s) => scopes.includes(s)).join(',')

  db()
    .prepare(
      `INSERT INTO api_tokens
         (id, user_id, name, prefix, token_hash, scopes, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, userId, name, token.slice(0, 12), hashToken(token), scopeCsv, now, expiresAt ?? null)

  const row = db().prepare(`SELECT * FROM api_tokens WHERE id = ?`).get(id) as ApiTokenRow
  return { token, row }
}

export interface AuthedToken {
  user: UserRow
  token: ApiTokenRow
  scopes: Set<ApiScope>
}

// last_used only needs coarse accuracy; skip the write if it's fresh. Mirrors
// touchLastSeen in lib/auth.ts.
const TOUCH_INTERVAL_MS = 60_000

/**
 * Resolve a raw bearer token to its user, or null.
 *
 * Rejects revoked, expired, and orphaned tokens, and — like session auth —
 * refuses any account that is not active, so suspending a user immediately
 * kills their API access too.
 */
export async function verifyToken(raw: string): Promise<AuthedToken | null> {
  if (!raw.startsWith('blx_')) return null

  const token = db()
    .prepare(`SELECT * FROM api_tokens WHERE token_hash = ?`)
    .get(hashToken(raw)) as ApiTokenRow | undefined

  if (!token) return null
  if (token.revoked_at) return null
  if (token.expires_at && token.expires_at < Date.now()) return null

  const user = db().prepare(`SELECT * FROM users WHERE id = ?`).get(token.user_id) as
    | UserRow
    | undefined
  if (!user || user.status !== 'active') return null

  await touchToken(token)

  return { user, token, scopes: parseScopes(token.scopes) }
}

async function touchToken(token: ApiTokenRow): Promise<void> {
  const now = Date.now()
  if (token.last_used_at && token.last_used_at > now - TOUCH_INTERVAL_MS) return
  const ip = await clientIpForStorage()
  db()
    .prepare(`UPDATE api_tokens SET last_used_at = ?, last_used_ip = ? WHERE id = ?`)
    .run(now, ip, token.id)
}

export function listTokens(userId: string): ApiTokenRow[] {
  return db()
    .prepare(`SELECT * FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC`)
    .all(userId) as ApiTokenRow[]
}

/** Revoke a token the caller owns. Returns whether a live token was revoked. */
export function revokeToken(userId: string, id: string): boolean {
  const res = db()
    .prepare(`UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL`)
    .run(Date.now(), id, userId)
  return res.changes > 0
}
