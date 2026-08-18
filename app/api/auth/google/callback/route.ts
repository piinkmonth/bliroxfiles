import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { db, type UserRow } from '@/lib/db'
import { LIMITS, PUBLIC_ORIGIN } from '@/lib/config'
import {
  createSession,
  clientIp,
  clientIpForStorage,
  userAgent,
  SESSION_COOKIE,
  cookieOptions,
} from '@/lib/auth'
import { checkInvite, redeemInvite } from '@/lib/invites'
import { diskState } from '@/lib/storage'
import { exchangeCode, takeFlow, OAUTH_STATE_COOKIE, type GoogleIdentity } from '@/lib/oauth'
import { newId } from '@/lib/ids'
import { audit } from '@/lib/audit'
import { createChallenge } from '@/lib/twofactor'
import { route } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Errors surface on a page, not as raw JSON — this is a browser navigation. */
function back(path: string, error?: string): NextResponse {
  const url = new URL(path, PUBLIC_ORIGIN)
  if (error) url.searchParams.set('error', error)
  return NextResponse.redirect(url)
}

export const GET = route(
  async (req: Request) => {
    const url = new URL(req.url)
    const jar = cookies()

    const returnedState = url.searchParams.get('state') ?? ''
    const cookieState = jar.get(OAUTH_STATE_COOKIE)?.value ?? ''
    jar.delete(OAUTH_STATE_COOKIE)

    if (url.searchParams.get('error')) {
      // User pressed cancel on Google's consent screen.
      return back('/login', 'Sign-in was cancelled')
    }

    // The cookie proves this callback landed in the browser that started the
    // flow. Without it, someone could complete a sign-in in a victim's browser.
    if (!returnedState || returnedState !== cookieState) {
      return back('/login', 'Sign-in expired or was tampered with — try again')
    }

    const flow = takeFlow(returnedState)
    if (!flow) return back('/login', 'Sign-in expired — try again')

    const code = url.searchParams.get('code')
    if (!code) return back('/login', 'Google did not return an authorization code')

    const result = await exchangeCode(code, flow)
    if (!result.ok) return back(flow.mode === 'link' ? '/settings' : '/login', result.error)

    const identity = result.identity
    const ip = clientIp()
    const storedIp = clientIpForStorage()

    // --- link to the account that started the flow -------------------------
    if (flow.mode === 'link') {
      if (!flow.link_user_id) return back('/settings', 'Link request was incomplete')

      const taken = db()
        .prepare(`SELECT id FROM users WHERE google_sub = ? AND id != ?`)
        .get(identity.sub, flow.link_user_id) as { id: string } | undefined
      if (taken) {
        return back('/settings', 'That Google account is already linked to another account')
      }

      db()
        .prepare(
          `UPDATE users
             SET google_sub = ?, google_email = ?, google_linked_at = ?, email_verified = 1,
                 email = COALESCE(email, ?)
           WHERE id = ?`,
        )
        .run(identity.sub, identity.email, Date.now(), identity.email, flow.link_user_id)

      audit({
        actorId: flow.link_user_id,
        action: 'auth.google_link',
        targetType: 'user',
        targetId: flow.link_user_id,
        ip: storedIp,
        detail: { email: identity.email },
      })

      return back('/settings')
    }

    // --- existing linked account -------------------------------------------
    const linked = db().prepare(`SELECT * FROM users WHERE google_sub = ?`).get(identity.sub) as
      | UserRow
      | undefined

    if (linked) {
      if (linked.status !== 'active') {
        return back('/login', linked.suspend_reason || 'This account is not active')
      }
      /*
       * Two-factor applies to Google sign-in as well. Skipping it here would
       * make "link Google" a way to turn the second factor off without ever
       * touching the 2FA settings.
       */
      if (linked.totp_enabled) {
        const url = new URL('/login', PUBLIC_ORIGIN)
        url.searchParams.set('challenge', createChallenge(linked.id))
        url.searchParams.set('user', linked.username)
        return NextResponse.redirect(url)
      }
      return signIn(linked, storedIp, ip)
    }

    // --- signup via invite --------------------------------------------------
    if (flow.mode === 'signup' && flow.invite_code) {
      const check = checkInvite(flow.invite_code)
      if (!check.valid) return back('/login', check.reason)

      if (diskState().freeBytes < 25 * 1024 ** 3) {
        return back('/login', 'Registrations are paused while the server is low on space')
      }

      const username = await pickUsername(identity)
      if (!username) {
        return back('/login', 'Could not derive a free username — sign up with a password instead')
      }

      if (!redeemInvite(flow.invite_code)) {
        return back('/login', 'That invite was just used up')
      }

      const id = newId()
      const now = Date.now()

      try {
        db()
          .prepare(
            `INSERT INTO users
               (id, username, email, password_hash, role, status, quota_bytes, used_bytes,
                invited_by, invite_code, signup_ip, created_at,
                google_sub, google_email, google_linked_at, email_verified)
             VALUES (?, ?, ?, '', 'user', 'active', ?, 0, ?, ?, ?, ?, ?, ?, ?, 1)`,
          )
          .run(
            id,
            username,
            identity.email,
            check.invite.quota_bytes || LIMITS.defaultQuotaBytes,
            check.invite.created_by,
            flow.invite_code,
            storedIp,
            now,
            identity.sub,
            identity.email,
            now,
          )
      } catch (err) {
        db()
          .prepare(`UPDATE invites SET uses = uses - 1 WHERE code = ? AND uses > 0`)
          .run(flow.invite_code)
        throw err
      }

      audit({
        actorId: id,
        actorName: username,
        action: 'user.register_google',
        targetType: 'user',
        targetId: id,
        ip: storedIp,
        detail: { email: identity.email, invitedBy: check.invite.created_by },
      })

      const fresh = db().prepare(`SELECT * FROM users WHERE id = ?`).get(id) as UserRow
      return signIn(fresh, storedIp, ip)
    }

    /*
     * A Google account nobody has linked, arriving at the login page.
     *
     * Deliberately NOT adopted into an account that merely shares this email
     * address: emails here are self-asserted and unverified, so matching on one
     * would let anyone claim someone else's address and wait to inherit their
     * account. Linking is done from settings, while already signed in.
     */
    return back(
      '/login',
      'No account is linked to that Google address. Sign in with your password, then link Google from settings.',
    )
  },
  { csrf: false },
)

function signIn(user: UserRow, storedIp: string | null, ip: string | null): NextResponse {
  const token = createSession(user.id, storedIp, userAgent())
  cookies().set(SESSION_COOKIE, token, cookieOptions())

  audit({
    actorId: user.id,
    actorName: user.username,
    action: 'auth.login_google',
    targetType: 'user',
    targetId: user.id,
    ip: storedIp,
  })

  return NextResponse.redirect(new URL('/dashboard', PUBLIC_ORIGIN))
}

/**
 * Derive a free username from the Google identity.
 *
 * Google names are not unique and may contain anything, so the local part of
 * the email is cleaned up and a numeric suffix added on collision. Users can
 * set a display name afterwards; the username is only ever an internal handle.
 */
async function pickUsername(identity: GoogleIdentity): Promise<string | null> {
  const base =
    identity.email
      .split('@')[0]
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '')
      .slice(0, 20) || 'user'

  const reserved = ['admin', 'root', 'system', 'blirox', 'support', 'moderator', 'mod', 'staff', 'api']
  const taken = (name: string) =>
    !!db().prepare(`SELECT 1 FROM users WHERE username = ?`).get(name) || reserved.includes(name)

  const padded = base.length >= 3 ? base : `${base}user`
  if (!taken(padded)) return padded

  for (let i = 2; i < 500; i++) {
    const candidate = `${padded.slice(0, 20)}${i}`
    if (!taken(candidate)) return candidate
  }
  return null
}
