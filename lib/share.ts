/**
 * Password-protected share links.
 *
 * A correct password sets a short-lived httpOnly cookie rather than handing
 * back a token in the URL — a token in a query string ends up in browser
 * history and in the Referer of anything the page links to, which for a
 * "private link" is precisely the wrong place for it.
 *
 * Lives here rather than in the route because Next route files may only export
 * HTTP method handlers, and both /unlock and /api/dl need this name.
 */
export function unlockCookieName(fileId: string): string {
  return `blirox_f_${fileId}`
}

/** How long a correct password keeps the file open in that browser. */
export const UNLOCK_TTL_SECONDS = 60 * 60

/**
 * Where to fetch a file's bytes from.
 *
 * File bytes normally come from the CDN hostname, which is the whole point of
 * having one. But every cookie this app sets — the session, and the per-file
 * unlock — is host-only: none carries a `domain` attribute, so the browser
 * scopes them to the app host and never sends them to `us01`. A request that
 * needs one of those cookies to be authorised therefore *cannot* be made
 * cross-origin, no matter what CORS says. It arrives anonymous and gets a 404.
 *
 * So the rule is: bytes go to the CDN host only when nothing about the request
 * depends on a cookie. Everything else is fetched same-origin, where the
 * cookies exist.
 *
 *   private             owner-only, needs the session
 *   password-protected  needs the unlock cookie from /unlock
 *   encrypted, unshared owner and collaborators only, needs the session
 *
 * The alternative, widening the session cookie to `.example.com` so it reaches
 * both hosts, was rejected deliberately. That host exists to serve files
 * uploaded by other people, and handing it the session cookie to make a
 * preview work is a poor trade for a URL that can simply be relative.
 *
 * Public files are unaffected and keep going to the CDN, which is where the
 * bulk of the bytes actually are.
 */
export function bytesUrl(
  file: {
    slug: string
    visibility: 'unlisted' | 'private'
    password_hash: string | null
    encrypted: number
    enc_share: number
  },
  cdnOrigin: string,
): string {
  const needsCookie =
    file.visibility === 'private' ||
    !!file.password_hash ||
    (!!file.encrypted && !file.enc_share)

  return needsCookie ? `/api/dl/${file.slug}` : `${cdnOrigin}/api/dl/${file.slug}`
}
