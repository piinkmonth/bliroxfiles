import crypto from 'node:crypto'

/**
 * Time-based one-time passwords, RFC 6238.
 *
 * Implemented directly rather than pulled in as a dependency — it is about
 * sixty lines of HMAC and base32, and an auth primitive is a poor place to
 * inherit somebody else's supply chain.
 *
 * SHA-1 is not a weakness here despite its reputation: TOTP uses it inside
 * HMAC, where collision resistance is irrelevant, and every authenticator app
 * in circulation assumes SHA-1. Choosing SHA-256 would mostly produce codes
 * that do not match what the user's app shows.
 */

const DIGITS = 6
const PERIOD_SECONDS = 30
/**
 * Accept the neighbouring windows too. Phone clocks drift, and a ±30s
 * tolerance is the usual trade — it widens the guess space from 10^6 to 3×10^6
 * per attempt, which the rate limiter handles.
 */
const SKEW_WINDOWS = 1

// --- base32, RFC 4648 without padding --------------------------------------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(buf: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''

  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '')
  const bytes: number[] = []
  let bits = 0
  let value = 0

  for (const char of clean) {
    const idx = B32.indexOf(char)
    if (idx === -1) continue
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}

// --- code generation --------------------------------------------------------

/** 20 bytes, as RFC 4226 recommends for HMAC-SHA1. */
export function generateSecret(): string {
  return base32Encode(crypto.randomBytes(20))
}

function codeForCounter(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8)
  // Counter is 64-bit; JS bitwise ops are 32-bit, so write the halves.
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0)
  buf.writeUInt32BE(counter >>> 0, 4)

  const hmac = crypto.createHmac('sha1', secret).update(buf).digest()

  // Dynamic truncation, RFC 4226 §5.4.
  const offset = hmac[hmac.length - 1] & 0x0f
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)

  return (binary % 10 ** DIGITS).toString().padStart(DIGITS, '0')
}

export function currentCounter(at = Date.now()): number {
  return Math.floor(at / 1000 / PERIOD_SECONDS)
}

/**
 * Check a submitted code.
 *
 * Returns the counter it matched so the caller can persist it and refuse the
 * same code a second time — without that, a code shoulder-surfed or captured
 * in transit stays valid for the rest of its 30-second window.
 */
export function verifyCode(
  secretBase32: string,
  code: string,
  opts: { lastUsedCounter?: number | null; at?: number } = {},
): { valid: boolean; counter?: number } {
  const cleaned = code.replace(/\D/g, '')
  if (cleaned.length !== DIGITS) return { valid: false }

  const secret = base32Decode(secretBase32)
  if (secret.length === 0) return { valid: false }

  const now = currentCounter(opts.at)

  for (let drift = -SKEW_WINDOWS; drift <= SKEW_WINDOWS; drift++) {
    const counter = now + drift
    if (opts.lastUsedCounter != null && counter <= opts.lastUsedCounter) continue

    const expected = codeForCounter(secret, counter)
    // Constant-time compare: both are fixed-length digit strings.
    if (
      crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(cleaned))
    ) {
      return { valid: true, counter }
    }
  }

  return { valid: false }
}

/** otpauth:// URI, which is what an authenticator app's QR code encodes. */
export function otpauthUri(opts: { secret: string; account: string; issuer: string }): string {
  const label = encodeURIComponent(`${opts.issuer}:${opts.account}`)
  const params = new URLSearchParams({
    secret: opts.secret,
    issuer: opts.issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  })
  return `otpauth://totp/${label}?${params}`
}

// --- backup codes -----------------------------------------------------------

/**
 * Single-use codes for when the phone is lost.
 *
 * Without these, losing a device means losing the account outright — there is
 * no email reset here for password accounts. Stored hashed, so a database leak
 * does not hand over a way in.
 */
export function generateBackupCodes(count = 10): string[] {
  const codes: string[] = []
  for (let i = 0; i < count; i++) {
    // 10 hex chars ≈ 40 bits. Grouped for legibility when written down.
    const raw = crypto.randomBytes(5).toString('hex')
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`)
  }
  return codes
}

export function hashBackupCode(code: string): string {
  return crypto.createHash('sha256').update(code.replace(/[^a-z0-9]/gi, '').toLowerCase()).digest('hex')
}

/** Returns the remaining hashes with the used one removed, or null on no match. */
export function consumeBackupCode(code: string, hashes: string[]): string[] | null {
  const target = hashBackupCode(code)
  const index = hashes.indexOf(target)
  if (index === -1) return null
  return hashes.filter((_, i) => i !== index)
}
