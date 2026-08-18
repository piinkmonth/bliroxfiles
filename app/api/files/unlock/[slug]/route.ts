import { cookies } from 'next/headers'
import { db, type FileRow } from '@/lib/db'
import { verifyPassword, clientIpForStorage } from '@/lib/auth'
import { audit } from '@/lib/audit'
import { ok, fail, route, jsonBody } from '@/lib/api'
import { PUBLIC_ORIGIN } from '@/lib/config'
import { unlockCookieName, UNLOCK_TTL_SECONDS } from '@/lib/share'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Exchange a share password for a short-lived cookie that permits download.
 *
 * A cookie rather than a query token so the password never lands in a URL,
 * where it would end up in browser history, and in the Referer header of
 * anything the page links to.
 */
export const POST = route(
  async (req: Request, { params }: { params: Promise<{ slug: string }> }) => {
    const { slug } = await params
    const body = await jsonBody<{ password?: string }>(req)
    if (!body?.password) return fail('Enter the password')

    const file = db().prepare(`SELECT * FROM files WHERE slug = ?`).get(slug) as
      | FileRow
      | undefined

    if (!file || file.deleted_at || file.status !== 'active') return fail('File not found', 404)
    if (!file.password_hash) return fail('That file is not password protected', 400)

    if (!verifyPassword(body.password, file.password_hash)) {
      audit({
        action: 'file.unlock_failed',
        targetType: 'file',
        targetId: file.id,
        ip: await clientIpForStorage(),
      })
      return fail('Wrong password', 403)
    }

    const jar = await cookies()
    jar.set(unlockCookieName(file.id), '1', {
      httpOnly: true,
      secure: PUBLIC_ORIGIN.startsWith('https://'),
      sameSite: 'lax',
      path: '/',
      maxAge: UNLOCK_TTL_SECONDS,
    })

    return ok({ unlocked: true })
  },
  // Rate limited to blunt password guessing against a share link.
  { limit: 'login', limitKey: (_req) => 'file-unlock' },
)
