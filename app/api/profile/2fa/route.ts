import { requireUser, verifyPassword, clientIpForStorage, destroyAllSessions } from '@/lib/auth'
import { db } from '@/lib/db'
import { encrypt, decrypt } from '@/lib/crypto'
import {
  generateSecret,
  verifyCode,
  otpauthUri,
  generateBackupCodes,
  hashBackupCode,
} from '@/lib/totp'
import { audit } from '@/lib/audit'
import { ok, fail, route, jsonBody } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ISSUER = 'blirox/files'

/**
 * Begin enrolment: mint a secret and return it plus a QR code.
 *
 * The secret is stored immediately but `totp_enabled` stays 0 until a code is
 * confirmed. Storing it first means the QR the user is looking at is the one
 * we will check against — regenerating on confirm would invalidate whatever
 * they just scanned.
 */
export const POST = route(async () => {
  const user = requireUser()
  if (user.totp_enabled) return fail('Two-factor is already on for this account', 409)

  const secret = generateSecret()
  db()
    .prepare(`UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?`)
    .run(encrypt(secret), user.id)

  const uri = otpauthUri({ secret, account: user.username, issuer: ISSUER })

  // Rendered server-side into a data: URI — the CSP already allows data: for
  // images, and this avoids shipping a QR renderer to the browser.
  const QRCode = (await import('qrcode')).default
  const qr = await QRCode.toDataURL(uri, { margin: 1, width: 240, errorCorrectionLevel: 'M' })

  return ok({
    // Shown so it can be typed by hand when a camera is not an option.
    secret,
    uri,
    qr,
  })
})

interface ConfirmBody {
  code?: string
}

/** Confirm a code and switch two-factor on, returning one-time backup codes. */
export const PUT = route(async (req: Request) => {
  const user = requireUser()
  if (user.totp_enabled) return fail('Two-factor is already on', 409)
  if (!user.totp_secret) return fail('Start enrolment first', 409)

  const body = await jsonBody<ConfirmBody>(req)
  if (!body?.code) return fail('Enter the six-digit code')

  const secret = decrypt(user.totp_secret)
  if (!secret) return fail('Stored secret is unreadable — start enrolment again', 500)

  const result = verifyCode(secret, body.code)
  if (!result.valid) return fail('That code is not right — check your app and try again', 403)

  const backupCodes = generateBackupCodes()

  db()
    .prepare(
      `UPDATE users
         SET totp_enabled = 1, totp_enabled_at = ?, totp_last_counter = ?, totp_backup_codes = ?
       WHERE id = ?`,
    )
    .run(
      Date.now(),
      result.counter ?? null,
      JSON.stringify(backupCodes.map(hashBackupCode)),
      user.id,
    )

  audit({
    actorId: user.id,
    actorName: user.username,
    action: 'auth.2fa_enabled',
    targetType: 'user',
    targetId: user.id,
    ip: clientIpForStorage(),
  })

  // The only time these are ever shown; only hashes are kept.
  return ok({ backupCodes })
})

interface DisableBody {
  password?: string
  code?: string
}

/**
 * Turn two-factor off.
 *
 * Requires the account password *and* a current code. Someone who has walked
 * up to an unlocked session should not be able to quietly strip the second
 * factor off the account.
 */
export const DELETE = route(async (req: Request) => {
  const user = requireUser()
  if (!user.totp_enabled) return fail('Two-factor is not on', 409)

  const body = await jsonBody<DisableBody>(req)

  if (user.password_hash) {
    if (!body?.password) return fail('Enter your password')
    if (!verifyPassword(body.password, user.password_hash)) {
      return fail('That password is not right', 403)
    }
  }

  const secret = user.totp_secret ? decrypt(user.totp_secret) : null
  if (!secret) return fail('Stored secret is unreadable', 500)

  if (!body?.code) return fail('Enter a code from your app')
  const result = verifyCode(secret, body.code, { lastUsedCounter: user.totp_last_counter })
  if (!result.valid) return fail('That code is not right', 403)

  db()
    .prepare(
      `UPDATE users
         SET totp_enabled = 0, totp_secret = NULL, totp_backup_codes = NULL,
             totp_last_counter = NULL, totp_enabled_at = NULL
       WHERE id = ?`,
    )
    .run(user.id)

  // Removing a factor is a security-relevant change; drop other sessions.
  destroyAllSessions(user.id)

  audit({
    actorId: user.id,
    actorName: user.username,
    action: 'auth.2fa_disabled',
    targetType: 'user',
    targetId: user.id,
    ip: clientIpForStorage(),
  })

  return ok({ disabled: true })
}, { limit: 'login', limitKey: () => '2fa-disable' })
