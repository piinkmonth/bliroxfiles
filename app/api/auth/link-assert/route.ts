import { db, type UserRow } from '@/lib/db'
import { verifyPassword, clientIpForStorage } from '@/lib/auth'
import { decrypt } from '@/lib/crypto'
import { verifyCode, consumeBackupCode } from '@/lib/totp'
import { createChallenge, takeChallenge } from '@/lib/twofactor'
import { audit } from '@/lib/audit'
import { ok, fail, route, jsonBody } from '@/lib/api'
import {
  LinkConfigError,
  callbackUrl,
  isReturnAllowed,
  signAssertion,
} from '@/lib/suitelink'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface Body {
  username?: string
  password?: string
  state?: string
  returnTo?: string
  /** Second step, when the account has two-factor on. */
  challenge?: string
  code?: string
}

/**
 * Prove this account's identity to blirox-id so it can be linked to a suite
 * account.
 *
 * Two rules make this safe, and neither is optional:
 *
 *   1. **A fresh password every time.** An existing session here is NOT
 *      accepted as proof. Without a fresh challenge, someone browsing Files
 *      with a valid cookie could be walked into linking their account to an
 *      attacker's suite identity without ever typing anything.
 *
 *   2. **Two-factor is honoured.** An account with TOTP on must complete it.
 *      Skipping it would make this endpoint a 2FA bypass — the password alone
 *      would yield an assertion that grants suite-wide access, which is
 *      precisely what the second factor exists to prevent.
 *
 * `returnTo` is validated against configuration rather than trusted, because it
 * arrives in the request. See lib/suitelink.ts.
 */
export const POST = route(
  async (req: Request) => {
    const body = await jsonBody<Body>(req)
    if (!body) return fail('Malformed request body')

    const state = (body.state ?? '').trim()
    const returnTo = (body.returnTo ?? '').trim()

    if (!state || !returnTo) return fail('Missing link request details')

    try {
      if (!isReturnAllowed(returnTo)) {
        return fail('That return address is not recognised', 400)
      }
    } catch (err) {
      if (err instanceof LinkConfigError) return fail(err.message, 503)
      throw err
    }

    const storedIp = await clientIpForStorage()

    /* ---- second step: two-factor -------------------------------------- */
    if (body.challenge) {
      const submitted = (body.code ?? '').trim()
      if (!submitted) return fail('Enter the six-digit code')

      const pending = takeChallenge(body.challenge)
      if (!pending) return fail('That link request expired — start again', 410)

      const user = db().prepare(`SELECT * FROM users WHERE id = ?`).get(pending.user_id) as
        | UserRow
        | undefined

      if (!user || user.status !== 'active') return fail('This account is not active', 403)
      if (!user.totp_enabled || !user.totp_secret) return fail('Two-factor is not on', 409)

      const totpSecret = decrypt(user.totp_secret)
      if (!totpSecret) return fail('Stored secret is unreadable', 500)

      // Same shape as /api/auth/2fa: six digits is a TOTP code, anything else
      // is treated as a backup code — which is how the user tells them apart.
      const result = /^\d{6}$/.test(submitted.replace(/\s/g, ''))
        ? verifyCode(totpSecret, submitted, { lastUsedCounter: user.totp_last_counter })
        : { valid: false as const }

      if (result.valid) {
        // Persist the counter so this exact code cannot be replayed inside its
        // remaining window. Omitting this makes a shoulder-surfed code good for
        // up to 30 more seconds.
        db()
          .prepare(`UPDATE users SET totp_last_counter = ? WHERE id = ?`)
          .run((result as { counter?: number }).counter ?? null, user.id)
      } else {
        const stored: string[] = user.totp_backup_codes ? JSON.parse(user.totp_backup_codes) : []
        const remaining = consumeBackupCode(submitted, stored)
        if (!remaining) {
          audit({
            actorId: user.id,
            actorName: user.username,
            action: 'auth.link_2fa_failed',
            targetType: 'user',
            targetId: user.id,
            ip: storedIp,
          })
          return fail('That code is not right', 403)
        }
        db()
          .prepare(`UPDATE users SET totp_backup_codes = ? WHERE id = ?`)
          .run(JSON.stringify(remaining), user.id)
      }

      return issue(user, state, returnTo, storedIp)
    }

    /* ---- first step: password ----------------------------------------- */
    const username = (body.username ?? '').trim()
    const password = body.password ?? ''
    if (!username || !password) return fail('Username and password are required')

    const user = db().prepare(`SELECT * FROM users WHERE username = ?`).get(username) as
      | UserRow
      | undefined

    /*
     * Google-created accounts have no password to re-verify. Rather than fall
     * back to something weaker, this refuses and points at the fix — an
     * account with no password cannot prove itself by password, and inventing
     * a softer path here would undermine the whole point of rule 1.
     */
    if (user && !user.password_hash) {
      return fail(
        'This account signs in with Google. Set a password in Settings first, then connect.',
        409,
      )
    }

    const valid = user ? verifyPassword(password, user.password_hash) : false
    if (!user || !valid) {
      audit({
        action: 'auth.link_failed',
        targetType: 'user',
        targetId: username,
        ip: storedIp,
      })
      return fail('Incorrect username or password', 401)
    }

    if (user.status === 'banned') return fail('This account has been permanently closed.', 403)
    if (user.status === 'suspended') {
      return fail(user.suspend_reason || 'This account is suspended pending review.', 403)
    }

    if (user.totp_enabled) {
      return ok({
        requiresTwoFactor: true,
        challenge: createChallenge(user.id),
        username: user.username,
      })
    }

    return issue(user, state, returnTo, storedIp)
  },
  {
    limit: 'login',
    limitKey: async (req) => {
      try {
        const body = await req.clone().json()
        return String(body?.username ?? '').toLowerCase().slice(0, 40)
      } catch {
        return ''
      }
    },
  },
)

function issue(user: UserRow, state: string, returnTo: string, storedIp: string | null) {
  const assertion = signAssertion(
    { sub: user.id, username: user.username, quotaBytes: user.quota_bytes },
    new URL(returnTo).origin,
  )

  audit({
    actorId: user.id,
    actorName: user.username,
    action: 'auth.link_asserted',
    targetType: 'user',
    targetId: user.id,
    ip: storedIp,
  })

  return ok({ redirect: callbackUrl(returnTo, state, assertion) })
}
