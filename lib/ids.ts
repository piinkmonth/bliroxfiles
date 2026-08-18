import crypto from 'node:crypto'

/** Unambiguous alphabet — no 0/O, 1/l/I. Share links get read aloud. */
const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'

function randomString(len: number): string {
  // Rejection-free: 31 chars doesn't divide 256 evenly, so mask to 5 bits (32)
  // and redraw the one out-of-range value rather than skewing the distribution.
  let out = ''
  while (out.length < len) {
    const bytes = crypto.randomBytes(len * 2)
    for (const b of bytes) {
      const v = b & 31
      if (v < ALPHABET.length) {
        out += ALPHABET[v]
        if (out.length === len) break
      }
    }
  }
  return out
}

/** Internal record id. */
export const newId = (): string => randomString(20)

/** Public share slug — shorter, still 8 * log2(31) ≈ 39 bits. */
export const newSlug = (): string => randomString(9)

/** Invite code, formatted in groups for readability. */
export function newInviteCode(): string {
  const raw = randomString(12)
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`
}

/** Session token. 32 bytes of entropy, url-safe. */
export const newSessionToken = (): string => crypto.randomBytes(32).toString('base64url')

/**
 * Public API token secret. The `blx_` prefix makes it greppable in logs and
 * recognisable to anyone handling one; 40 chars of the alphabet is ~198 bits.
 */
export const newApiTokenSecret = (): string => `blx_${randomString(40)}`
