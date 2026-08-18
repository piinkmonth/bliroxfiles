import { currentUser } from '@/lib/auth'
import { db, type FileRow } from '@/lib/db'
import { fileAccess } from '@/lib/collab'
import { ok, fail, route } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Encryption metadata for a file.
 *
 * This contains no secret — an IV prefix, frame size, and the original name and
 * type. All of it is useless without the key, which never leaves the browser
 * that derived it.
 *
 * Who gets it:
 *
 * - the owner, and anyone the folder is shared with, because they need it to
 *   decrypt anything at all;
 * - anyone at all, when the owner has published a share link for the file,
 *   since a recipient holding the link and the passphrase needs it for exactly
 *   the same reason.
 *
 * That last case does disclose the original filename to whoever holds the
 * link, ahead of them proving they know the passphrase. Filenames are stored
 * in the clear today, so this is a property of the link existing rather than
 * of this endpoint — publishing one is the point at which that trade is made,
 * and the dashboard says so before it is made.
 */
export const GET = route(async (_req: Request, { params }: { params: { id: string } }) => {
  const file = db().prepare(`SELECT * FROM files WHERE id = ?`).get(params.id) as
    | FileRow
    | undefined

  if (!file || file.deleted_at || file.status !== 'active') return fail('File not found', 404)
  if (!file.encrypted || !file.enc_meta) return fail('That file is not encrypted', 400)

  if (!file.enc_share) {
    const viewer = currentUser()
    if (!viewer || !fileAccess(file, viewer.id)) return fail('File not found', 404)
  }

  return ok({ encMeta: file.enc_meta })
})
