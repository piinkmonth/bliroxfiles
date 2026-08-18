import { NextResponse } from 'next/server'
import { AuthError, clientIp } from './auth'
import { checkOrigin, isMutating } from './csrf'
import { consume, tooMany, type LIMITS } from './ratelimit'

export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json({ ok: true, ...data }, init)
}

/**
 * `headers` exists for routes reachable cross-origin: an error response that
 * omits the CORS headers its success path sends reaches the browser as an
 * opaque network failure, hiding the message it was carrying.
 */
export function fail(
  message: string,
  status = 400,
  extra?: Record<string, unknown>,
  headers?: HeadersInit,
) {
  return NextResponse.json({ ok: false, error: message, ...extra }, { status, headers })
}

export interface RouteOptions {
  /** Rate-limit bucket to charge. Omit for no limit beyond the global one. */
  limit?: keyof typeof LIMITS
  /**
   * Extra qualifier appended to the IP for the bucket key — usually a
   * username, so one attacker cannot lock a specific account out from an
   * unrelated address.
   */
  limitKey?: (req: Request) => string | Promise<string>
  /** Opt out of the CSRF origin check. Only for endpoints with no cookie auth. */
  csrf?: boolean
}

/**
 * Wrap a route handler with the protections that should never be forgotten:
 * CSRF origin checking on mutations, optional rate limiting, and error
 * handling that does not leak stack traces or filesystem paths.
 *
 * Applying these here rather than per-route means a new endpoint is protected
 * by default. Forgetting to add a guard is the common way these gaps appear.
 */
export function route<Args extends unknown[]>(
  handler: (...args: Args) => Promise<Response>,
  options: RouteOptions = {},
): (...args: Args) => Promise<Response> {
  return async (...args: Args) => {
    try {
      const req = args[0] as Request | undefined

      if (req && options.csrf !== false && isMutating(req.method)) {
        const csrf = checkOrigin()
        if (!csrf.ok) {
          console.warn('[csrf] rejected', req.method, req.url, csrf.reason)
          return fail('Request blocked: bad origin', 403)
        }
      }

      if (options.limit && req) {
        const ip = clientIp() ?? 'unknown'
        const extra = options.limitKey ? await options.limitKey(req) : ''
        const result = consume(options.limit, extra ? `${ip}:${extra}` : ip)
        if (!result.allowed) {
          return tooMany(result, 'Too many requests — slow down and try again shortly')
        }
      }

      return await handler(...args)
    } catch (err) {
      if (err instanceof AuthError) return fail(err.message, err.status)
      console.error('[api]', err)
      return fail('Something went wrong', 500)
    }
  }
}

/** Parse a JSON body, returning null rather than throwing on malformed input. */
export async function jsonBody<T = Record<string, unknown>>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T
  } catch {
    return null
  }
}
