import { requireUser } from '@/lib/auth'
import { db, type FolderRow } from '@/lib/db'
import { PUBLIC_ORIGIN } from '@/lib/config'
import { newSlug } from '@/lib/ids'
import { audit } from '@/lib/audit'
import { ok, fail, route, jsonBody } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface Params {
  params: Promise<{ id: string }>
}

/**
 * Publish or withdraw a folder's gallery link.
 *
 * Owner-only, and never for an encrypted folder: a gallery is a page of
 * thumbnails, and there is nothing to make a thumbnail of when the server is
 * holding ciphertext.
 *
 * Withdrawing clears the token rather than flagging it, so the old URL is not
 * merely refused but stops corresponding to anything. Publishing again mints a
 * fresh one — a link that was handed out and pulled back does not come alive
 * again later.
 */
export const POST = route(async (req: Request, { params }: Params) => {
  const { id } = await params
  const user = await requireUser()
  const body = await jsonBody<{ enabled?: boolean }>(req)
  if (typeof body?.enabled !== 'boolean') return fail('enabled must be true or false')

  const folder = db()
    .prepare(`SELECT * FROM folders WHERE id = ? AND owner_id = ?`)
    .get(id, user.id) as FolderRow | undefined

  if (!folder) return fail('Folder not found', 404)

  if (body.enabled && folder.encrypted) {
    return fail('Encrypted folders cannot have a gallery — there is nothing readable to show', 409)
  }

  const token = body.enabled ? newSlug() : null

  db()
    .prepare(`UPDATE folders SET share_token = ?, share_created_at = ? WHERE id = ? AND owner_id = ?`)
    .run(token, token ? Date.now() : null, folder.id, user.id)

  audit({
    actorId: user.id,
    actorName: user.username,
    action: body.enabled ? 'folder.gallery_publish' : 'folder.gallery_withdraw',
    targetType: 'folder',
    targetId: folder.id,
  })

  return ok({
    token,
    url: token ? `${PUBLIC_ORIGIN}/g/${token}` : null,
  })
}, { limit: 'mutation' })
