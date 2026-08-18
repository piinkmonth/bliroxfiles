import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth'
import { checkInvite } from '@/lib/invites'
import { beginFlow, googleConfigured, OAUTH_STATE_COOKIE, type OAuthMode } from '@/lib/oauth'
import { PUBLIC_ORIGIN } from '@/lib/config'
import { fail, route } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Kick off a Google sign-in.
 *
 *   ?mode=login              existing account
 *   ?mode=signup&code=...    redeem an invite into a new account
 *   ?mode=link               attach Google to the account already signed in
 *
 * A GET that changes no state, so it is exempt from the CSRF origin check —
 * it is a top-level navigation from a link, where browsers send no Origin.
 */
export const GET = route(
  async (req: Request) => {
    if (!googleConfigured()) {
      return fail('Google sign-in is not configured on this server', 503)
    }

    const url = new URL(req.url)
    const mode = (url.searchParams.get('mode') ?? 'login') as OAuthMode
    if (!['login', 'signup', 'link'].includes(mode)) return fail('Unknown mode')

    let inviteCode: string | null = null
    let linkUserId: string | null = null

    if (mode === 'signup') {
      // Validate the invite before sending anyone to Google, so a dead code
      // fails here rather than after a confusing round trip.
      inviteCode = (url.searchParams.get('code') ?? '').trim().toLowerCase()
      const check = checkInvite(inviteCode)
      if (!check.valid) return fail(check.reason, 403)
    }

    if (mode === 'link') {
      const user = await currentUser()
      if (!user) return fail('Sign in first', 401)
      if (user.google_sub) return fail('This account is already linked to Google', 409)
      linkUserId = user.id
    }

    const { state, url: authUrl } = beginFlow({ mode, inviteCode, linkUserId })

    // Binds the callback to this browser. sameSite 'lax' is required: the
    // callback arrives as a top-level navigation from accounts.google.com, and
    // 'strict' would withhold the cookie exactly when it is needed.
    const jar = await cookies()
    jar.set(OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      secure: PUBLIC_ORIGIN.startsWith('https://'),
      sameSite: 'lax',
      path: '/',
      maxAge: 600,
    })

    return NextResponse.redirect(authUrl)
  },
  { csrf: false },
)
