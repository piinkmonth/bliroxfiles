import { db } from './db'

/**
 * Rate limiting, backed by SQLite.
 *
 * An in-memory counter resets on every deploy and every crash, which is
 * precisely when an attacker benefits most. Persisting to the database the app
 * already depends on keeps limits meaningful across restarts, at the cost of a
 * write per request on limited routes — negligible at this scale.
 *
 * Fixed windows rather than a sliding log: an attacker can get 2x the limit
 * across a window boundary, which is an acceptable trade for O(1) storage and
 * no per-request row growth.
 */

let ready = false

function ensureTable() {
  if (ready) return
  db().exec(`
    CREATE TABLE IF NOT EXISTS rate_limits (
      bucket      TEXT PRIMARY KEY,
      count       INTEGER NOT NULL,
      window_start INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rate_window ON rate_limits(window_start);
  `)
  ready = true
}

export interface Limit {
  /** Requests permitted per window. */
  max: number
  /** Window length in milliseconds. */
  windowMs: number
}

export const LIMITS = {
  /** Password guessing. Deliberately tight. */
  login: { max: 8, windowMs: 15 * 60_000 },
  /** Invite probing — each attempt burns a guess at a 12-char code. */
  register: { max: 10, windowMs: 60 * 60_000 },
  /** Report spam from one address. */
  report: { max: 20, windowMs: 60 * 60_000 },
  /** Upload session churn. Generous: legitimate bulk uploads are normal. */
  uploadInit: { max: 120, windowMs: 60 * 60_000 },
  /** Avatar re-encoding is CPU-heavy, so it gets its own bucket. */
  avatar: { max: 20, windowMs: 60 * 60_000 },
  /** Folder creation, to stop someone making a million rows. */
  folderCreate: { max: 200, windowMs: 60 * 60_000 },
  /** Catch-all for other mutations. */
  mutation: { max: 600, windowMs: 60 * 60_000 },
  /** Public API reads, keyed by token. Generous — this is the swapfile case. */
  apiRead: { max: 6000, windowMs: 60 * 60_000 },
  /** Public API writes (create/modify), keyed by token. */
  apiWrite: { max: 600, windowMs: 60 * 60_000 },
  /** Public API uploads — one-shot POST and chunked init/complete, keyed by token. Matches uploadInit. */
  apiUpload: { max: 120, windowMs: 60 * 60_000 },
  /**
   * Public API chunk PUTs, keyed by token. Generous on purpose: a single large
   * file is hundreds of chunks, so this has to clear a real upload rather than
   * cap it. Chunk size is already bounded, and quota/disk stop actual abuse.
   */
  apiChunk: { max: 6000, windowMs: 60 * 60_000 },
} satisfies Record<string, Limit>

export interface LimitResult {
  allowed: boolean
  remaining: number
  /** Seconds until the window resets — becomes the Retry-After header. */
  retryAfter: number
}

/**
 * Consume one unit from a bucket.
 *
 * `key` should identify the actor as precisely as available — an IP, or an IP
 * plus username so one person cannot lock out another by guessing at their
 * account from a different address.
 */
export function consume(name: keyof typeof LIMITS, key: string): LimitResult {
  ensureTable()

  const limit = LIMITS[name]
  const bucket = `${name}:${key}`
  const now = Date.now()

  const row = db()
    .prepare(`SELECT count, window_start FROM rate_limits WHERE bucket = ?`)
    .get(bucket) as { count: number; window_start: number } | undefined

  // Fresh window: either no record, or the previous one has aged out.
  if (!row || now - row.window_start >= limit.windowMs) {
    db()
      .prepare(
        `INSERT INTO rate_limits (bucket, count, window_start) VALUES (?, 1, ?)
         ON CONFLICT(bucket) DO UPDATE SET count = 1, window_start = excluded.window_start`,
      )
      .run(bucket, now)
    return { allowed: true, remaining: limit.max - 1, retryAfter: 0 }
  }

  const retryAfter = Math.ceil((row.window_start + limit.windowMs - now) / 1000)

  if (row.count >= limit.max) {
    return { allowed: false, remaining: 0, retryAfter }
  }

  db().prepare(`UPDATE rate_limits SET count = count + 1 WHERE bucket = ?`).run(bucket)
  return { allowed: true, remaining: limit.max - row.count - 1, retryAfter }
}

/** Clear a bucket — called on successful login so a legitimate user isn't punished. */
export function reset(name: keyof typeof LIMITS, key: string): void {
  ensureTable()
  db().prepare(`DELETE FROM rate_limits WHERE bucket = ?`).run(`${name}:${key}`)
}

/** Drop windows that have long since expired. Called from maintenance. */
export function sweepRateLimits(): number {
  ensureTable()
  const oldest = Math.max(...Object.values(LIMITS).map((l) => l.windowMs))
  const result = db()
    .prepare(`DELETE FROM rate_limits WHERE window_start < ?`)
    .run(Date.now() - oldest * 2)
  return result.changes
}

/** 429 response with the right Retry-After. */
export function tooMany(result: LimitResult, message = 'Too many requests') {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status: 429,
    headers: {
      'Content-Type': 'application/json',
      'Retry-After': String(Math.max(1, result.retryAfter)),
    },
  })
}
