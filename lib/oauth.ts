import crypto from 'node:crypto'
import { db } from './db'
import { PUBLIC_ORIGIN } from './config'

/**
 * Google Sign-In, via the OpenID Connect authorization-code flow with PKCE.
 *
 * Flow state (the CSRF `state`, the ID-token `nonce`, and the PKCE verifier)
 * lives in a short-lived database row rather than a cookie: it must survive the
 * round trip to Google, it must be single-use, and a cookie large enough to
 * carry all of it plus an invite code starts bumping into header size limits.
 * A cookie still holds the state *key*, which binds the callback to the
 * browser that started it — without that, an attacker can complete a flow in
 * someone else's browser and silently sign them into an account they control.
 */

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token'
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com']

export const OAUTH_STATE_COOKIE = 'blirox_oauth'
/** Flows are short by nature; anything older is abandoned or replayed. */
const STATE_TTL_MS = 10 * 60_000

/**
 * Read a credential from the environment, tolerating the ways they get pasted.
 *
 * Placeholder documentation is usually written as `<your-client-id>`, and the
 * angle brackets come along with the copy more often than not. Google then
 * rejects the request with a bare `invalid_client`, which says nothing about
 * the cause and is genuinely hard to spot — the brackets are URL-encoded to
 * %3C/%3E by the time they appear anywhere you would look.
 *
 * Surrounding quotes get the same treatment, for the same reason.
 */
function credential(name: string): string | null {
  const raw = process.env[name]
  if (!raw) return null

  const cleaned = raw.trim().replace(/^[<"']+/, '').replace(/[>"']+$/, '').trim()
  if (!cleaned) return null

  if (cleaned !== raw.trim()) {
    console.warn(
      `[oauth] ${name} had surrounding brackets or quotes; using the value inside them. ` +
        `Remove them from your .env to silence this.`,
    )
  }
  return cleaned
}

export function googleConfigured(): boolean {
  return !!(credential('BLIROX_GOOGLE_CLIENT_ID') && credential('BLIROX_GOOGLE_CLIENT_SECRET'))
}

function clientId(): string {
  const v = credential('BLIROX_GOOGLE_CLIENT_ID')
  if (!v) throw new Error('BLIROX_GOOGLE_CLIENT_ID is not set')
  return v
}

function clientSecret(): string {
  const v = credential('BLIROX_GOOGLE_CLIENT_SECRET')
  if (!v) throw new Error('BLIROX_GOOGLE_CLIENT_SECRET is not set')
  return v
}

/** Must match a redirect URI registered in the Google Cloud console exactly. */
export function redirectUri(): string {
  return process.env.BLIROX_GOOGLE_REDIRECT_URI ?? `${PUBLIC_ORIGIN}/api/auth/google/callback`
}

// ---------------------------------------------------------------------------
// Flow state
// ---------------------------------------------------------------------------

let tableReady = false
function ensureTable() {
  if (tableReady) return
  db().exec(`
    CREATE TABLE IF NOT EXISTS oauth_states (
      state         TEXT PRIMARY KEY,
      nonce         TEXT NOT NULL,
      code_verifier TEXT NOT NULL,
      mode          TEXT NOT NULL,          -- login | signup | link
      invite_code   TEXT,
      link_user_id  TEXT,
      created_at    INTEGER NOT NULL,
      expires_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_oauth_expiry ON oauth_states(expires_at);
  `)
  tableReady = true
}

export type OAuthMode = 'login' | 'signup' | 'link'

export interface FlowState {
  state: string
  nonce: string
  code_verifier: string
  mode: OAuthMode
  invite_code: string | null
  link_user_id: string | null
}

const b64url = (buf: Buffer) => buf.toString('base64url')

export function beginFlow(opts: {
  mode: OAuthMode
  inviteCode?: string | null
  linkUserId?: string | null
}): { state: string; url: string } {
  ensureTable()

  const state = b64url(crypto.randomBytes(32))
  const nonce = b64url(crypto.randomBytes(24))
  const codeVerifier = b64url(crypto.randomBytes(48))
  const challenge = b64url(crypto.createHash('sha256').update(codeVerifier).digest())
  const now = Date.now()

  db()
    .prepare(
      `INSERT INTO oauth_states
         (state, nonce, code_verifier, mode, invite_code, link_user_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      state,
      nonce,
      codeVerifier,
      opts.mode,
      opts.inviteCode ?? null,
      opts.linkUserId ?? null,
      now,
      now + STATE_TTL_MS,
    )

  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    // `select_account` so a shared machine does not silently reuse whichever
    // Google account happens to be signed in.
    prompt: 'select_account',
  })

  return { state, url: `${GOOGLE_AUTH}?${params}` }
}

/** Fetch and consume a flow. Single-use: the row is deleted on read. */
export function takeFlow(state: string): FlowState | null {
  ensureTable()

  const row = db().prepare(`SELECT * FROM oauth_states WHERE state = ?`).get(state) as
    | (FlowState & { expires_at: number })
    | undefined

  // Delete regardless of validity so a replayed state cannot be retried.
  db().prepare(`DELETE FROM oauth_states WHERE state = ?`).run(state)

  if (!row || row.expires_at < Date.now()) return null
  return row
}

export function sweepOAuthStates(): number {
  ensureTable()
  return db().prepare(`DELETE FROM oauth_states WHERE expires_at < ?`).run(Date.now()).changes
}

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

export interface GoogleIdentity {
  sub: string
  email: string
  emailVerified: boolean
  name: string | null
  picture: string | null
}

interface IdTokenClaims {
  iss: string
  aud: string
  sub: string
  exp: number
  nonce?: string
  email?: string
  email_verified?: boolean
  name?: string
  picture?: string
}

/**
 * Decode a JWT payload without verifying its signature.
 *
 * Safe *only* because this token came straight from Google's token endpoint
 * over TLS, authenticated with our client secret — OpenID Connect Core §3.1.3.7
 * explicitly permits skipping signature validation in that case. The claims are
 * still checked below. Never use this on a token that arrived from a client.
 */
function decodeIdToken(idToken: string): IdTokenClaims | null {
  try {
    const payload = idToken.split('.')[1]
    if (!payload) return null
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as IdTokenClaims
  } catch {
    return null
  }
}

export async function exchangeCode(
  code: string,
  flow: FlowState,
): Promise<{ ok: true; identity: GoogleIdentity } | { ok: false; error: string }> {
  let res: Response
  try {
    res = await fetch(GOOGLE_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId(),
        client_secret: clientSecret(),
        redirect_uri: redirectUri(),
        grant_type: 'authorization_code',
        code_verifier: flow.code_verifier,
      }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    return { ok: false, error: `Could not reach Google: ${err instanceof Error ? err.message : ''}` }
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    console.error('[oauth] token exchange failed', res.status, detail.slice(0, 400))
    return { ok: false, error: 'Google rejected the sign-in attempt' }
  }

  const body = (await res.json()) as { id_token?: string }
  if (!body.id_token) return { ok: false, error: 'Google did not return an identity token' }

  const claims = decodeIdToken(body.id_token)
  if (!claims) return { ok: false, error: 'Identity token could not be read' }

  // --- claim checks --------------------------------------------------------
  if (!GOOGLE_ISSUERS.includes(claims.iss)) {
    return { ok: false, error: 'Identity token has the wrong issuer' }
  }
  if (claims.aud !== clientId()) {
    return { ok: false, error: 'Identity token was issued for a different application' }
  }
  if (claims.exp * 1000 < Date.now()) {
    return { ok: false, error: 'Identity token has expired' }
  }
  // Binds this token to the flow we started, so one cannot be replayed into another.
  if (claims.nonce !== flow.nonce) {
    return { ok: false, error: 'Identity token does not match this sign-in attempt' }
  }
  if (!claims.email) {
    return { ok: false, error: 'Google did not share an email address' }
  }
  /*
   * Google issues unverified addresses for some workspace and alias
   * configurations. Accepting one would undo the entire reason for using OAuth
   * here, which is getting an address somebody else has already proven.
   */
  if (claims.email_verified !== true) {
    return { ok: false, error: 'That Google account has an unverified email address' }
  }

  return {
    ok: true,
    identity: {
      sub: claims.sub,
      email: claims.email.toLowerCase(),
      emailVerified: true,
      name: claims.name ?? null,
      picture: claims.picture ?? null,
    },
  }
}
