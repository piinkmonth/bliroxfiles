import crypto from 'node:crypto'

/**
 * Proving this account's identity to blirox-id, for "Connect your existing
 * Blirox Files account".
 *
 * Files acts as the identity provider for exactly one exchange: the user
 * re-authenticates here, and we hand back a short-lived signed assertion of
 * who they are. blirox-id verifies it and records the link.
 *
 * HS256 signed with a shared secret rather than public-key crypto: both ends
 * are operated by the same person on the same machine, so a second key
 * distribution problem would be ceremony solving a threat that does not exist.
 *
 * Written against node:crypto rather than adding `jose` — a JWT this simple is
 * a HMAC over two base64url segments, and a live app does not need a new
 * dependency for it.
 */

const ASSERTION_TTL_SECONDS = 120

/** Who we claim to be. Must match the `app` blirox-id started the flow with. */
export const ISSUER = 'files'

export class LinkConfigError extends Error {}

function secret(): string {
  const raw = process.env.BLIROX_LINK_SECRET
  if (!raw || raw.length < 32) {
    throw new LinkConfigError(
      'BLIROX_LINK_SECRET is missing or under 32 characters. Account linking is disabled.',
    )
  }
  return raw
}

/**
 * The one origin we will send an assertion to.
 *
 * `return_to` arrives in the query string, so it is attacker-controlled. If it
 * were trusted, anyone could send a user here with their own return_to and
 * collect a valid assertion for that user's account — a full account takeover
 * dressed up as a redirect. It is compared against configuration and never
 * pattern-matched.
 */
export function expectedReturnOrigin(): string {
  const raw = process.env.BLIROX_ID_ORIGIN
  if (!raw) {
    throw new LinkConfigError('BLIROX_ID_ORIGIN is not set. Account linking is disabled.')
  }
  return new URL(raw).origin
}

export function linkingAvailable(): boolean {
  try {
    secret()
    expectedReturnOrigin()
    return true
  } catch {
    return false
  }
}

/** Exact origin match. A different host, scheme or port is a different origin. */
export function isReturnAllowed(returnTo: string): boolean {
  try {
    return new URL(returnTo).origin === expectedReturnOrigin()
  } catch {
    return false
  }
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url')
}

export interface AssertionClaims {
  /** Local user id. Becomes app_links.local_id on the suite side. */
  sub: string
  username: string
  /**
   * This account's storage allowance. blirox-id takes the MAXIMUM of this and
   * the suite default — never the sum, so linking cannot be used to farm space.
   */
  quotaBytes?: number
}

export function signAssertion(claims: AssertionClaims, audience: string): string {
  const now = Math.floor(Date.now() / 1000)

  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64url(
    JSON.stringify({
      iss: ISSUER,
      aud: audience,
      sub: claims.sub,
      username: claims.username,
      ...(claims.quotaBytes ? { quota_bytes: claims.quotaBytes } : {}),
      iat: now,
      exp: now + ASSERTION_TTL_SECONDS,
    }),
  )

  const signature = crypto
    .createHmac('sha256', secret())
    .update(`${header}.${payload}`)
    .digest('base64url')

  return `${header}.${payload}.${signature}`
}

/** Where to send the browser once the user has proven who they are. */
export function callbackUrl(returnTo: string, state: string, assertion: string): string {
  const url = new URL('/connect/callback', returnTo)
  url.searchParams.set('state', state)
  url.searchParams.set('assertion', assertion)
  return url.toString()
}
