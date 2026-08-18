import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { db, type FileRow } from '@/lib/db'
import { currentUser } from '@/lib/auth'
import { ensureThumb } from '@/lib/preview'
import { route } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Small preview image for a file.
 *
 * Separate from /api/dl on purpose. This is derived, re-encoded, EXIF-stripped
 * data of bounded size, so it can be handed to a link unfurler and rendered on
 * a page without pulling the original down — which for a 40 MB photo is the
 * difference between a preview and a download.
 *
 * It is also not a download: it takes no egress slot and never touches the
 * counter, because a thumbnail appearing in a Discord embed is not somebody
 * fetching the file.
 */
export const GET = route(async (_req: Request, { params }: { params: { slug: string } }) => {
  const file = db().prepare(`SELECT * FROM files WHERE slug = ?`).get(params.slug) as
    | FileRow
    | undefined

  if (!file || file.deleted_at || file.status !== 'active') return notFound()
  if (file.expires_at && file.expires_at < Date.now()) return notFound()

  const viewer = currentUser()
  const isOwner = !!viewer && viewer.id === file.owner_id

  /*
   * Anything the file page itself would gate, this gates identically.
   *
   * A thumbnail of a password-protected file is a preview of content the
   * password is there to withhold, and the unlock cookie is not something a
   * link unfurler will ever hold — so for everyone but the owner it is simply
   * absent, rather than being a 401 that reveals the file exists.
   */
  if (!isOwner) {
    if (file.visibility === 'private') return notFound()
    if (file.password_hash) return notFound()
    if (file.encrypted) return notFound()
  }

  const thumb = await ensureThumb(file)
  if (!thumb) return notFound()

  const stat = await fsp.stat(thumb.absPath).catch(() => null)
  if (!stat) return notFound()

  return new Response(fs.createReadStream(thumb.absPath) as unknown as ReadableStream, {
    status: 200,
    headers: {
      'Content-Type': thumb.mime,
      'Content-Length': String(stat.size),
      // A thumbnail is immutable for the life of the file, so a browser may
      // hold it. `private` still keeps it out of the shared Cloudflare cache,
      // matching how the originals are handled.
      'Cache-Control': 'private, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cross-Origin-Resource-Policy': 'cross-origin',
    },
  })
})

function notFound() {
  return new Response('Not found', { status: 404 })
}
