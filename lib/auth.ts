import crypto from 'node:crypto'
import { cookies, headers } from 'next/headers'
import { db, type Role, type UserRow } from './db'
import { LIMITS } from './config'
import { newSessionToken } from './ids'
import { encryptIp } from './crypto'
import { audit } from './audit'

export const SESSION_COOKIE = 'blirox_session'

/** session cookie attributes. shared by login + register. */
export function cookieOptions() {
  return {
    httpOnly: true,
    // TLS terminates at cloudflare + the app is only reachable through the
    // tunnel, so prod is always an HTTPS context
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: Math.floor(LIMITS.sessionTtlMs / 1000),
  }
}

// ---------------------------------------------------------------------------
// password hashing — scrypt from node core, no native dep to build.
// format: scrypt$N$r$p$salt_b64$hash_b64
// ---------------------------------------------------------------------------

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 32 }

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(password.normalize('NFKC'), salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    // scrypt needs ram ≈ 128 * N * r; the default 32 MB cap is too low at N=2^15
    maxmem: 256 * 1024 * 1024,
  })
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$')
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, N, r, p, saltB64, hashB64] = stored.split('$')
    if (scheme !== 'scrypt') return false

    const salt = Buffer.from(saltB64, 'base64')
    const expected = Buffer.from(hashB64, 'base64')
    const actual = crypto.scryptSync(password.normalize('NFKC'), salt, expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
      maxmem: 256 * 1024 * 1024,
    })
    return crypto.timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

export async function createSession(userId: string, ip: string | null, ua: string | null): Promise<string> {
  const token = newSessionToken()
  const now = Date.now()
  const country = await clientCountry()
  db()
    .prepare(
      `INSERT INTO sessions (token, user_id, ip, user_agent, country, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(token, userId, ip, ua, country, now, now + LIMITS.sessionTtlMs)
  return token
}

export function destroySession(token: string): void {
  db().prepare(`DELETE FROM sessions WHERE token = ?`).run(token)
}

/** kill every session for a user — used on ban, suspend, password change. */
export function destroyAllSessions(userId: string): void {
  db().prepare(`DELETE FROM sessions WHERE user_id = ?`).run(userId)
}

export async function userForToken(token: string): Promise<UserRow | null> {
  const row = db()
    .prepare(
      `SELECT u.*, s.country AS session_country FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > ?`,
    )
    .get(token, Date.now()) as (UserRow & { session_country: string | null }) | undefined

  if (!row) return null
  // banned/suspended keeps its rows but loses all access
  if (row.status !== 'active') return null
  if (!(await passesGeoGuard(token, row, row.session_country))) return null
  return row
}

// ---------------------------------------------------------------------------
// geo guard
// ---------------------------------------------------------------------------

/**
 * kill a session whose traffic jumped to a different country.
 *
 * a token that suddenly shows up from somewhere else is the shape of a stolen
 * cookie, so we destroy the session, not just flag it. its ALSO the shape of a
 * VPN toggle / a flight / a mobile carrier reroute — which is why geo_guard is
 * a per-account opt-in and why we tell the account holder what happened instead
 * of silently logging them out.
 *
 * only THIS session dies. other devices are fine — the evidence is about one
 * token moving, not the account.
 *
 * a session with no recorded country (local dev, or something cloudflare
 * couldnt resolve) gets adopted into the current country instead of counting as
 * a mismatch. failing open matters here: treating "unknown" as a change would
 * log everyone out on the first request after the deploy that added the column.
 */
async function passesGeoGuard(
  token: string,
  user: UserRow,
  sessionCountry: string | null,
): Promise<boolean> {
  if (!user.geo_guard) return true

  const now = await clientCountry()
  if (!now) return true

  if (!sessionCountry) {
    db().prepare(`UPDATE sessions SET country = ? WHERE token = ?`).run(now, token)
    return true
  }

  if (sessionCountry === now) return true

  destroySession(token)
  recordSecurityNotice(user.id, 'session.geo_revoked', { from: sessionCountry, to: now })
  audit({
    actorId: user.id,
    actorName: user.username,
    action: 'session.geo_revoked',
    targetType: 'user',
    targetId: user.id,
    detail: { from: sessionCountry, to: now },
  })
  return false
}

/**
 * queue something the account holder has to see.
 *
 * goes in the db not a cookie: the guard runs inside server components where
 * Next wont let u set a cookie, and a warning about a hijacked session is
 * useless if closing the tab makes it disappear.
 */
export function recordSecurityNotice(
  userId: string,
  kind: string,
  detail?: unknown,
): void {
  try {
    db()
      .prepare(
        `INSERT INTO security_notices (user_id, kind, detail, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(userId, kind, detail === undefined ? null : JSON.stringify(detail), Date.now())
  } catch (err) {
    console.error('[security] failed to record notice', kind, err)
  }
}

export interface SecurityNotice {
  id: number
  kind: string
  detail: Record<string, unknown> | null
  createdAt: number
}

/** unacknowledged notices, newest first. */
export function pendingNotices(userId: string, limit = 5): SecurityNotice[] {
  const rows = db()
    .prepare(
      `SELECT id, kind, detail, created_at FROM security_notices
       WHERE user_id = ? AND seen_at IS NULL
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(userId, limit) as {
    id: number
    kind: string
    detail: string | null
    created_at: number
  }[]

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    detail: r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : null,
    createdAt: r.created_at,
  }))
}

export function acknowledgeNotices(userId: string, ids: number[]): void {
  if (ids.length === 0) return
  db()
    .prepare(
      `UPDATE security_notices SET seen_at = ?
       WHERE user_id = ? AND seen_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`,
    )
    .run(Date.now(), userId, ...ids)
}

/** current user from the request cookie, or null. */
export async function currentUser(): Promise<UserRow | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value
  if (!token) return null

  const user = await userForToken(token)
  if (user) touchLastSeen(user.id)
  return user
}

export interface SessionSummary {
  token: string
  country: string | null
  userAgent: string | null
  createdAt: number
  expiresAt: number
  current: boolean
}

/**
 * a user's live sessions, for the security panel. we return the token so the
 * panel can mark the current one + revoke a specific other one — its already in
 * their own cookie and every row here belongs to them anyway.
 */
export async function sessionsForUser(userId: string): Promise<SessionSummary[]> {
  const current = (await cookies()).get(SESSION_COOKIE)?.value ?? null
  return (
    db()
      .prepare(
        `SELECT token, country, user_agent, created_at, expires_at FROM sessions
         WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC`,
      )
      .all(userId, Date.now()) as {
      token: string
      country: string | null
      user_agent: string | null
      created_at: number
      expires_at: number
    }[]
  ).map((s) => ({
    token: s.token,
    country: s.country,
    userAgent: s.user_agent,
    createdAt: s.created_at,
    expiresAt: s.expires_at,
    current: s.token === current,
  }))
}

// last_seen_at only needs minute accuracy, so skip the write if its fresh
const TOUCH_INTERVAL_MS = 60_000
function touchLastSeen(userId: string) {
  const now = Date.now()
  db()
    .prepare(`UPDATE users SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)`)
    .run(now, userId, now - TOUCH_INTERVAL_MS)
}

// ---------------------------------------------------------------------------
// authorisation
// ---------------------------------------------------------------------------

const RANK: Record<Role, number> = { user: 0, mod: 1, admin: 2 }

export function hasRole(user: UserRow | null, min: Role): boolean {
  if (!user) return false
  return RANK[user.role] >= RANK[min]
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

/** throws if theres no active session. */
export async function requireUser(): Promise<UserRow> {
  const user = await currentUser()
  if (!user) throw new AuthError('Sign in required', 401)
  return user
}

/** throws if the session lacks the given role. */
export async function requireRole(min: Role): Promise<UserRow> {
  const user = await requireUser()
  if (!hasRole(user, min)) throw new AuthError('Not permitted', 403)
  return user
}

// ---------------------------------------------------------------------------
// request metadata
// ---------------------------------------------------------------------------

/**
 * real client IP. cloudflared sets CF-Connecting-IP, and since the app only
 * listens on localhost behind the tunnel an outside client cant spoof it. keep
 * it bound to 127.0.0.1 and keep it that way.
 */
export async function clientIp(): Promise<string | null> {
  const h = await headers()
  return h.get('cf-connecting-ip') ?? h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
}

/**
 * two-letter country from cloudflare's CF-IPCountry header. free + always
 * current, no GeoIP db to ship or update — cloudflare resolves it at the edge
 * before the tunnel. null when the header's missing (local dev) or cloudflare
 * couldnt resolve it, which it sends as "XX" or "T1" (tor exit nodes).
 */
export async function clientCountry(): Promise<string | null> {
  const code = (await headers()).get('cf-ipcountry')
  if (!code || code === 'XX' || code === 'T1') return null
  return /^[A-Z]{2}$/.test(code) ? code : null
}

/** IP encrypted for storage. see lib/crypto.ts for why we dont hash it. */
export async function clientIpForStorage(): Promise<string | null> {
  return encryptIp(await clientIp())
}

export async function userAgent(): Promise<string | null> {
  return (await headers()).get('user-agent')
}

/** sweep expired sessions + acked notices. cheap, called on a timer. */
export function sweepExpired(): void {
  const now = Date.now()
  db().prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(now)
  // keep acked notices a month so a returning user can still see why they got
  // signed out, then drop them — the audit log is the permanent record
  db()
    .prepare(`DELETE FROM security_notices WHERE seen_at IS NOT NULL AND seen_at < ?`)
    .run(now - 30 * 86400_000)
}
