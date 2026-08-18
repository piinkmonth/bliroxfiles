/**
 * Shared file-metadata limits and sanitisers.
 *
 * These rules gate what an owner can set on a file — its display name, note,
 * expiry, and burn budget — and are used by both the web edit route and the
 * API. Keeping them in one module means the API cannot drift into accepting a
 * note the web UI would reject, or vice versa.
 */

/** A year out. Beyond this an "expiry" is indistinguishable from none. */
export const MAX_EXPIRY_MS = 365 * 86400_000
export const MAX_BURN_DOWNLOADS = 1000
export const MAX_NOTE_LENGTH = 500
export const MAX_NAME_LENGTH = 255

/**
 * Display name cleanup. Names end up in pages and Content-Disposition headers,
 * so any leading path components are dropped and control characters stripped;
 * the value is length-bounded. This is display metadata only — blobs are stored
 * under generated ids, so a name never touches a real path — but a slash in a
 * name is still ugly and pointless, so it goes.
 */
export function sanitiseFileName(raw: string): string {
  const base = raw.split(/[/\\]/).pop() ?? ''
  // eslint-disable-next-line no-control-regex
  return base.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, MAX_NAME_LENGTH)
}

/**
 * Note cleanup. Shown on a public page, so it gets the same control-character
 * stripping the name does — bidi overrides in particular can disguise text
 * entirely. Newlines survive; a note is a description, not a single line.
 */
export function sanitiseNote(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f‪-‮⁦-⁩]/g, '').trim()
}

/**
 * The optional fields an API upload can set on the file it creates: its
 * visibility, note, expiry, burn budget, and whether the uploader is hidden.
 * Every field is optional — an omitted field takes the file's column default.
 */
export interface CreateOptions {
  visibility?: 'unlisted' | 'private'
  note?: string | null
  expiresAt?: number | null
  burnAfter?: number | null
  anonymous?: boolean
}

/** Coerce a JSON value or query/form string to a trimmed string, or null. */
function asStr(v: unknown): string | null {
  if (v === undefined || v === null) return null
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return null
}

/**
 * Validate the creation options an upload may carry.
 *
 * Shared by the one-shot upload (which reads them from query params / form
 * fields, i.e. strings) and the chunked flow (which reads them from a JSON
 * body, i.e. typed values), so the two paths cannot diverge on what they
 * accept. Values are coerced, so `"5"`, `5`, `true` and `"true"` all work.
 * Expiry may be given as `expiresAt` (absolute epoch ms) or `expiresIn`
 * (seconds from now); the absolute form wins if both are present.
 */
export function parseCreateOptions(
  raw: Record<string, unknown>,
): { ok: true; opts: CreateOptions } | { ok: false; error: string } {
  const opts: CreateOptions = {}
  const now = Date.now()

  const vis = asStr(raw.visibility)
  if (vis !== null && vis !== '') {
    if (vis !== 'unlisted' && vis !== 'private') {
      return { ok: false, error: 'visibility must be "unlisted" or "private"' }
    }
    opts.visibility = vis
  }

  const note = asStr(raw.note)
  if (note !== null) {
    const cleaned = sanitiseNote(note)
    if (cleaned.length > MAX_NOTE_LENGTH) {
      return { ok: false, error: `Note must be ${MAX_NOTE_LENGTH} characters or fewer` }
    }
    opts.note = cleaned || null
  }

  const at = asStr(raw.expiresAt)
  const inSecs = asStr(raw.expiresIn)
  if (at !== null && at !== '') {
    const ms = Number(at)
    if (!Number.isFinite(ms)) return { ok: false, error: 'expiresAt must be an epoch-ms timestamp' }
    if (ms < now - 60_000) return { ok: false, error: 'That expiry is in the past' }
    if (ms > now + MAX_EXPIRY_MS) return { ok: false, error: 'Expiry cannot be more than a year out' }
    opts.expiresAt = Math.round(ms)
  } else if (inSecs !== null && inSecs !== '') {
    const secs = Number(inSecs)
    if (!Number.isFinite(secs) || secs <= 0) {
      return { ok: false, error: 'expiresIn must be a positive number of seconds' }
    }
    const ms = now + secs * 1000
    if (ms > now + MAX_EXPIRY_MS) return { ok: false, error: 'Expiry cannot be more than a year out' }
    opts.expiresAt = Math.round(ms)
  }

  const burn = asStr(raw.burnAfter)
  if (burn !== null && burn !== '') {
    const n = Number(burn)
    if (!Number.isInteger(n) || n < 1 || n > MAX_BURN_DOWNLOADS) {
      return { ok: false, error: `burnAfter must be between 1 and ${MAX_BURN_DOWNLOADS}` }
    }
    opts.burnAfter = n
  }

  if (raw.anonymous !== undefined && raw.anonymous !== null) {
    opts.anonymous = raw.anonymous === true || raw.anonymous === 'true' || raw.anonymous === '1'
  }

  return { ok: true, opts }
}
