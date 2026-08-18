import { NextResponse } from 'next/server'
import { AuthError } from './auth'
import { consume, tooMany, type LIMITS } from './ratelimit'
import { verifyToken, type AuthedToken } from './apitokens'
import type { ApiScope } from './db'

/**
 * Route wrapper for the public API (app/api/v1/**), the bearer-token
 * counterpart to `route()` in lib/api.ts.
 *
 * Differences from the cookie API, and why:
 *
 *   - **No CSRF check.** CSRF rides an ambient cookie a browser attaches
 *     automatically; a bearer token is sent deliberately by the caller and is
 *     never attached on its behalf, so there is nothing to forge. This is the
 *     same reasoning lib/csrf.ts uses to allow header-less requests.
 *   - **`Access-Control-Allow-Origin: *`.** These responses carry no cookies,
 *     so a wildcard is both valid and correct — unlike the byte routes, which
 *     are credentialed and must reflect a specific origin.
 *   - **Rate-limited by token, not IP.** The token is the actor; a script
 *     moving between addresses is still one client.
 */

/** Added to every real response. Preflight sends the fuller set below. */
const CORS_BASE: Record<string, string> = { 'Access-Control-Allow-Origin': '*' }

const CORS_PREFLIGHT: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Filename, Range',
  'Access-Control-Max-Age': '86400',
}

/** Success envelope: `{ ok: true, ...data }` with CORS. */
export function apiOk<T>(data: T, init?: ResponseInit) {
  const headers = new Headers(init?.headers)
  for (const [k, v] of Object.entries(CORS_BASE)) headers.set(k, v)
  return NextResponse.json({ ok: true, ...data }, { ...init, headers })
}

/** Error envelope: `{ ok: false, error }` with CORS, and a challenge on 401. */
export function apiFail(message: string, status = 400, extra?: Record<string, unknown>) {
  const headers = new Headers(CORS_BASE)
  if (status === 401) headers.set('WWW-Authenticate', 'Bearer')
  return NextResponse.json({ ok: false, error: message, ...extra }, { status, headers })
}

/** Copy a handler's Response, adding CORS — used for streamed/raw responses. */
function withCors(res: Response): Response {
  const headers = new Headers(res.headers)
  for (const [k, v] of Object.entries(CORS_BASE)) headers.set(k, v)
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

/**
 * Shared CORS preflight handler. Next dispatches by method name, so a `GET`
 * export never sees an `OPTIONS` request — every v1 route re-exports this as
 * its `OPTIONS` so browser preflight gets the allowance it needs.
 */
export function apiOptions(): Response {
  return new Response(null, { status: 204, headers: CORS_PREFLIGHT })
}

/** Pull and verify the bearer token, or throw the right AuthError. */
function requireBearer(req: Request): AuthedToken {
  const header = req.headers.get('authorization') ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (!match) throw new AuthError('Missing API token — send it as: Authorization: Bearer <token>', 401)

  const auth = verifyToken(match[1].trim())
  if (!auth) throw new AuthError('Invalid, expired, or revoked API token', 401)
  return auth
}

export interface ApiRouteOptions {
  /** Scope the token must carry to use this endpoint. */
  scope: ApiScope
  /** Rate-limit bucket, charged against the token id. */
  limit: keyof typeof LIMITS
}

/**
 * Wrap a v1 handler with bearer auth, scope enforcement, per-token rate
 * limiting, CORS, and uniform error handling. The authenticated `{ user,
 * token, scopes }` is injected as the handler's third argument.
 */
export function apiRoute<Ctx>(
  handler: (req: Request, ctx: Ctx, auth: AuthedToken) => Promise<Response>,
  options: ApiRouteOptions,
): (req: Request, ctx: Ctx) => Promise<Response> {
  return async (req: Request, ctx: Ctx) => {
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_PREFLIGHT })
    }

    try {
      const auth = requireBearer(req)

      if (!auth.scopes.has(options.scope)) {
        throw new AuthError(`This token lacks the '${options.scope}' scope`, 403)
      }

      const rl = consume(options.limit, auth.token.id)
      if (!rl.allowed) return withCors(tooMany(rl, 'API rate limit exceeded — slow down'))

      return withCors(await handler(req, ctx, auth))
    } catch (err) {
      if (err instanceof AuthError) return apiFail(err.message, err.status)
      console.error('[api/v1]', err)
      return apiFail('Something went wrong', 500)
    }
  }
}
