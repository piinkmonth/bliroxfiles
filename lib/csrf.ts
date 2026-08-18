import { headers } from 'next/headers'
import { HOSTS, PUBLIC_ORIGIN } from './config'

/**
 * origin-based CSRF defence for state-changing requests.
 *
 * the session cookie is SameSite=Lax, which already blocks cross-site POSTs from
 * forms + fetch. but Lax isnt everything — it still sends the cookie on
 * top-level GET navigations, and leaning on one control for a whole attack class
 * is how that class comes back. checking Origin/Referer against the hosts we
 * actually serve is a cheap independent second layer.
 *
 * browsers set Origin on every cross-origin request + every same-origin POST,
 * and page JS cant forge it — which is exactly where a CSRF attacker sits.
 */

function allowedHosts(): Set<string> {
  const hosts = new Set<string>()
  for (const h of [HOSTS.app, ...HOSTS.cdn]) if (h) hosts.add(h.toLowerCase())

  try {
    hosts.add(new URL(PUBLIC_ORIGIN).host.toLowerCase())
  } catch {
    /* malformed origin in config */
  }

  // local dev, where u hit the app by host:port directly
  if (process.env.NODE_ENV !== 'production') {
    hosts.add('localhost')
    for (const port of ['4001', '4002', '3000']) {
      hosts.add(`localhost:${port}`)
      hosts.add(`127.0.0.1:${port}`)
    }
  }
  return hosts
}

/**
 * echo back an Origin only if its one of ours.
 *
 * this is for CORS on the byte-serving routes. app + CDN are different origins
 * but the same site, so a fetch() from an app-host page to `us01` is
 * cross-origin and needs an explicit Access-Control-Allow-Origin.
 *
 * we reflect the caller's origin instead of sending `*` on purpose: a wildcard
 * is invalid on a credentialed request, and these carry the session cookie so an
 * owner can fetch their own unpublished file. reflecting is only safe bc its
 * gated on the same allowlist CSRF uses — an arbitrary origin gets nothing back
 * and the browser refuses the response.
 */
export function allowedOrigin(origin: string | null): string | null {
  if (!origin || origin === 'null') return null
  try {
    const host = new URL(origin).host.toLowerCase()
    return allowedHosts().has(host) ? origin : null
  } catch {
    return null
  }
}

export interface CsrfResult {
  ok: boolean
  reason?: string
}

export async function checkOrigin(): Promise<CsrfResult> {
  const h = await headers()
  const origin = h.get('origin')
  const referer = h.get('referer')
  const allowed = allowedHosts()

  // origin is the reliable signal when its there
  if (origin) {
    // some clients send the literal "null" origin (sandboxed iframes,
    // redirects). NEVER treat that as same-origin
    if (origin === 'null') return { ok: false, reason: 'null origin' }
    try {
      const host = new URL(origin).host.toLowerCase()
      return allowed.has(host)
        ? { ok: true }
        : { ok: false, reason: `origin ${host} not permitted` }
    } catch {
      return { ok: false, reason: 'malformed origin' }
    }
  }

  // fall back to Referer when theres no Origin
  if (referer) {
    try {
      const host = new URL(referer).host.toLowerCase()
      return allowed.has(host)
        ? { ok: true }
        : { ok: false, reason: `referer ${host} not permitted` }
    } catch {
      return { ok: false, reason: 'malformed referer' }
    }
  }

  /*
   * neither header. browsers always send at least one on a cross-origin
   * state-changing request, so this is basically curl or a script — which cant
   * be a CSRF victim anyway, theres no ambient cookie to ride. allowing it keeps
   * the API usable from the command line without weakening the browser guarantee.
   */
  return { ok: true }
}

/** true for methods that change state, so they need the check. */
export function isMutating(method: string): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())
}
