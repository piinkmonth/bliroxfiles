import { cookies } from 'next/headers'
import { db, type UserRow } from '@/lib/db'
import {
  createSession,
  clientIpForStorage,
  userAgent,
  SESSION_COOKIE,
  cookieOptions,
} from '@/lib/auth'
import { decrypt } from '@/lib/crypto'
import { verifyCode, consumeBackupCode } from '@/lib/totp'
import { audit } from '@/lib/audit'
import { ok, fail, route, jsonBody } from '@/lib/api'
import { takeChallenge } from '@/lib/twofactor'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface Body {
  challenge?: string
  code?: string
}

/**
 * Second step of a two-factor sign-in.
 *
 * The password step issues a challenge instead of a session; only a valid code
 * against that challenge produces one. The challenge is single-use and short
 * lived, so a captured one is not a standing invitation.
 */
export const POST = route(
  async (req: Request) => {
    const body = await jsonBody<Body>(req)
    if (!body?.challenge || !body?.code) return fail('Enter the six-digit code')

    const pending = takeChallenge(body.challenge)
    if (!pending) return fail('That sign-in expired — start again', 410)

    const user = db().prepare(`SELECT * FROM users WHERE id = ?`).get(pending.user_id) as
      | UserRow
      | undefined

    if (!user || user.status !== 'active') return fail('This account is not active', 403)
    if (!user.totp_enabled || !user.totp_secret) return fail('Two-factor is not on', 409)

    const secret = decrypt(user.totp_secret)
    if (!secret) return fail('Stored secret is unreadable', 500)

    const submitted = body.code.trim()
    let usedBackup = false

    // A six-digit string is a TOTP code; anything else is treated as a backup
    // code, which is how the user tells them apart too.
    const result = /^\d{6}$/.test(submitted.replace(/\s/g, ''))
      ? verifyCode(secret, submitted, { lastUsedCounter: user.totp_last_counter })
      : { valid: false as const }

    if (result.valid) {
      // Record the counter so this exact code cannot be replayed inside its
      // remaining window.
      db()
        .prepare(`UPDATE users SET totp_last_counter = ? WHERE id = ?`)
        .run(result.counter ?? null, user.id)
    } else {
      const stored: string[] = user.totp_backup_codes ? JSON.parse(user.totp_backup_codes) : []
      const remaining = consumeBackupCode(submitted, stored)
      if (!remaining) {
        audit({
          actorId: user.id,
          actorName: user.username,
          action: 'auth.2fa_failed',
          targetType: 'user',
          targetId: user.id,
          ip: await clientIpForStorage(),
        })
        return fail('That code is not right', 403)
      }

      usedBackup = true
      db()
        .prepare(`UPDATE users SET totp_backup_codes = ? WHERE id = ?`)
        .run(JSON.stringify(remaining), user.id)
    }

    const storedIp = await clientIpForStorage()
    const token = await createSession(user.id, storedIp, await userAgent())
    const jar = await cookies()
    jar.set(SESSION_COOKIE, token, cookieOptions())

    audit({
      actorId: user.id,
      actorName: user.username,
      action: usedBackup ? 'auth.login_backup_code' : 'auth.login_2fa',
      targetType: 'user',
      targetId: user.id,
      ip: storedIp,
    })

    const backupsLeft = user.totp_backup_codes
      ? (JSON.parse(user.totp_backup_codes) as string[]).length - (usedBackup ? 1 : 0)
      : 0

    return ok({
      userId: user.id,
      username: user.username,
      usedBackup,
      // Surfaced so someone burning through backup codes gets a warning before
      // they run out entirely.
      backupCodesRemaining: backupsLeft,
    })
  },
  { limit: 'login', limitKey: () => '2fa-verify' },
)
