import { cookies } from 'next/headers'
import { db } from '@/lib/db'
import { LIMITS } from '@/lib/config'
import { hashPassword, createSession, clientIp, userAgent, SESSION_COOKIE, cookieOptions, clientIpForStorage } from '@/lib/auth'
import { checkInvite, redeemInvite } from '@/lib/invites'
import { diskState } from '@/lib/storage'
import { newId } from '@/lib/ids'
import { audit } from '@/lib/audit'
import { ok, fail, route, jsonBody } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface RegisterBody {
  code?: string
  username?: string
  email?: string
  password?: string
}

/**
 * Redeem an invite into an account. This is the only way an account is
 * created — there is no open signup path anywhere in the app.
 */
export const POST = route(async (req: Request) => {
  const body = await jsonBody<RegisterBody>(req)
  if (!body) return fail('Malformed request body')

  const code = (body.code ?? '').trim().toLowerCase()
  const username = (body.username ?? '').trim()
  const email = (body.email ?? '').trim() || null
  const password = body.password ?? ''

  const usernameError = validateUsername(username)
  if (usernameError) return fail(usernameError)

  const passwordError = validatePassword(password)
  if (passwordError) return fail(passwordError)

  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return fail('That email address does not look valid')
  }

  const check = checkInvite(code)
  if (!check.valid) return fail(check.reason, 403)

  const taken = db().prepare(`SELECT 1 FROM users WHERE username = ?`).get(username)
  if (taken) return fail('That username is taken')

  if (email) {
    const emailTaken = db().prepare(`SELECT 1 FROM users WHERE email = ?`).get(email)
    if (emailTaken) return fail('An account already uses that email')
  }

  // Overcommit is intentional, but admitting a new account onto a disk that is
  // already full just moves the failure to their first upload.
  const disk = diskState()
  if (disk.freeBytes < 25 * 1024 ** 3) {
    return fail('Registrations are paused while the server is low on space', 503)
  }

  // Redeem before insert: if two people race the last use of an invite, the
  // one whose UPDATE loses never gets an account.
  if (!redeemInvite(code)) {
    return fail('That invite was just used up', 403)
  }

  const id = newId()
  const now = Date.now()
  const ip = await clientIp()
  // Stored encrypted; see lib/crypto.ts for why this is not a hash.
  const storedIp = await clientIpForStorage()

  try {
    db()
      .prepare(
        `INSERT INTO users
           (id, username, email, password_hash, role, status, quota_bytes, used_bytes,
            invited_by, invite_code, signup_ip, created_at)
         VALUES (?, ?, ?, ?, 'user', 'active', ?, 0, ?, ?, ?, ?)`,
      )
      .run(
        id,
        username,
        email,
        hashPassword(password),
        check.invite.quota_bytes || LIMITS.defaultQuotaBytes,
        check.invite.created_by,
        code,
        storedIp,
        now,
      )
  } catch (err) {
    // Give the invite use back — the account was never created.
    db().prepare(`UPDATE invites SET uses = uses - 1 WHERE code = ? AND uses > 0`).run(code)
    throw err
  }

  const token = await createSession(id, storedIp, await userAgent())
  const jar = await cookies()
  jar.set(SESSION_COOKIE, token, cookieOptions())

  audit({
    actorId: id,
    actorName: username,
    action: 'user.register',
    targetType: 'user',
    targetId: id,
    ip: storedIp,
    detail: { inviteCode: code, invitedBy: check.invite.created_by, quotaBytes: check.invite.quota_bytes },
  })

  return ok({ userId: id, username })
}, { limit: 'register' })

function validateUsername(username: string): string | null {
  if (username.length < 3) return 'Username must be at least 3 characters'
  if (username.length > 24) return 'Username must be 24 characters or fewer'
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
    return 'Username can only contain letters, numbers, underscores and hyphens'
  }
  const reserved = ['admin', 'root', 'system', 'blirox', 'support', 'moderator', 'mod', 'staff', 'api']
  if (reserved.includes(username.toLowerCase())) return 'That username is reserved'
  return null
}

function validatePassword(password: string): string | null {
  if (password.length < 10) return 'Password must be at least 10 characters'
  if (password.length > 200) return 'Password is too long'
  // Length is doing the work here; composition rules mostly produce
  // "Password1!" and a false sense of security.
  const weak = ['password', '1234567890', 'qwertyuiop', 'letmein123']
  if (weak.some((w) => password.toLowerCase().includes(w))) {
    return 'That password is too predictable — try a passphrase'
  }
  return null
}
