import crypto from 'node:crypto'

/**
 * reversible encryption for personal data at rest — currently just IP addresses.
 *
 * encryption on purpose, NOT hashing. IPv4 is a 32-bit space, so a rainbow table
 * of every possible address is minutes of work — a salted hash of an IP is
 * barely privacy. and 18 U.S.C. § 2258A makes us hand the uploader's IP to a
 * CyberTipline report, which a one-way hash would make impossible.
 *
 * AES-256-GCM: private if the db leaks on its own, recoverable when legally
 * required, authenticated so tampering shows.
 */

const KEY_ENV = 'BLIROX_ENCRYPTION_KEY'
let cachedKey: Buffer | null = null

function key(): Buffer {
  if (cachedKey) return cachedKey

  const raw = process.env[KEY_ENV]
  if (!raw) {
    throw new Error(
      `${KEY_ENV} is not set. Personal data cannot be stored without it.\n` +
        `Generate one with:\n` +
        `  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"\n` +
        `and add it to .env.local / .env.production.\n` +
        `Keep it backed up — losing it makes existing encrypted values unreadable.`,
    )
  }

  const buf = Buffer.from(raw, 'base64')
  if (buf.length !== 32) {
    throw new Error(`${KEY_ENV} must decode to exactly 32 bytes (got ${buf.length}).`)
  }

  cachedKey = buf
  return buf
}

/** true when a usable key is configured. lets callers degrade instead of crashing. */
export function encryptionAvailable(): boolean {
  try {
    key()
    return true
  } catch {
    return false
  }
}

/**
 * encrypt to `v1.<iv>.<tag>.<ciphertext>`, all base64url. the version prefix lets
 * us change the scheme later without guessing how an old value was produced.
 */
export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.')
}

/** decrypt a value produced by encrypt. null if it cant be read. */
export function decrypt(value: string): string | null {
  try {
    const [version, ivB64, tagB64, ctB64] = value.split('.')
    if (version !== 'v1') return null

    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key(),
      Buffer.from(ivB64, 'base64url'),
    )
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'))
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, 'base64url')),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    return null
  }
}

/**
 * encrypt an IP for storage. if no key is configured we return null instead of
 * silently writing the raw IP — a column thats sometimes ciphertext and
 * sometimes a plain address is worse than either.
 */
export function encryptIp(ip: string | null | undefined): string | null {
  if (!ip) return null
  if (!encryptionAvailable()) {
    console.warn(`[crypto] ${KEY_ENV} not set — IP not stored`)
    return null
  }
  return encrypt(ip)
}

export function decryptIp(stored: string | null | undefined): string | null {
  if (!stored) return null
  // values written before encryption was enabled are plain addresses
  if (!stored.startsWith('v1.')) return stored
  return decrypt(stored)
}

/**
 * stable, non-reversible key for rate-limit buckets + abuse counting. a hash is
 * fine here: never used to identify anyone, just to group requests, and its
 * peppered server-side so buckets cant be predicted or probed from outside.
 */
export function ipBucket(ip: string | null | undefined): string {
  if (!ip) return 'unknown'
  const pepper = process.env[KEY_ENV] ?? 'blirox-default-pepper'
  return crypto.createHmac('sha256', pepper).update(ip).digest('base64url').slice(0, 22)
}
