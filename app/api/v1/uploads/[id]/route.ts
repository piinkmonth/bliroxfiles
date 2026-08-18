import fsp from 'node:fs/promises'
import { apiRoute, apiOk, apiFail, apiOptions } from '@/lib/apiauth'
import { db } from '@/lib/db'
import { stagingDir } from '@/lib/storage'
import { getSession, sessionStatus } from '@/lib/uploads'
import { audit } from '@/lib/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface Ctx {
  params: { id: string }
}

/**
 * GET /v1/uploads/:id — session status.
 *
 * The `missing` array is what makes resume work: a client that dropped
 * mid-upload reads it and re-sends only those chunk indices.
 */
export const GET = apiRoute<Ctx>(
  async (_req, { params }, { user }) => {
    const session = getSession(params.id)
    if (!session || session.owner_id !== user.id) {
      return apiFail('Upload session not found', 404)
    }
    return apiOk({ upload: sessionStatus(session) })
  },
  { scope: 'read', limit: 'apiRead' },
)

/** DELETE /v1/uploads/:id — abandon an upload and free the staged bytes now. */
export const DELETE = apiRoute<Ctx>(
  async (_req, { params }, { user }) => {
    const session = getSession(params.id)
    if (!session || session.owner_id !== user.id) {
      return apiFail('Upload session not found', 404)
    }

    await fsp.rm(stagingDir(session.id), { recursive: true, force: true })
    db().prepare(`DELETE FROM upload_sessions WHERE id = ?`).run(session.id)

    audit({
      actorId: user.id,
      actorName: user.username,
      action: 'upload.abort',
      targetType: 'upload',
      targetId: session.id,
      detail: { via: 'api', filename: session.filename, receivedChunks: session.received_count },
    })

    return apiOk({ aborted: true })
  },
  { scope: 'write', limit: 'apiWrite' },
)

export const OPTIONS = apiOptions
