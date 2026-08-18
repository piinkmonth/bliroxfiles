import { apiRoute, apiOk, apiOptions } from '@/lib/apiauth'
import { db } from '@/lib/db'
import { quotaFor } from '@/lib/storage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** GET /v1/account — who this token belongs to, and how much room is left. */
export const GET = apiRoute(
  async (_req, _ctx, { user }) => {
    const q = quotaFor(user.id)

    const files = db()
      .prepare(
        `SELECT COUNT(*) AS n FROM files
         WHERE owner_id = ? AND status = 'active' AND deleted_at IS NULL`,
      )
      .get(user.id) as { n: number }

    const folders = db()
      .prepare(`SELECT COUNT(*) AS n FROM folders WHERE owner_id = ?`)
      .get(user.id) as { n: number }

    return apiOk({
      account: {
        username: user.username,
        quotaBytes: q.quotaBytes,
        usedBytes: q.usedBytes,
        freeBytes: q.freeBytes,
        files: files.n,
        folders: folders.n,
      },
    })
  },
  { scope: 'read', limit: 'apiRead' },
)

export const OPTIONS = apiOptions
