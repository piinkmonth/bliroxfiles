import fsp from 'node:fs/promises'
import { requireUser } from '@/lib/auth'
import { db } from '@/lib/db'
import { stagingDir } from '@/lib/storage'
import { getSession, sessionStatus } from '@/lib/uploads'
import { audit } from '@/lib/audit'
import { ok, fail, route } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface Params {
  params: { id: string }
}

/**
 * Upload session status. The `missing` array is what makes resume work: a
 * client that dropped mid-upload asks here and re-sends only those indices.
 */
export const GET = route(async (_req: Request, { params }: Params) => {
  const user = requireUser()
  const session = getSession(params.id)
  if (!session || session.owner_id !== user.id) return fail('Upload session not found', 404)
  return ok(sessionStatus(session))
})

/** Abandon an upload and free the staged bytes immediately. */
export const DELETE = route(async (_req: Request, { params }: Params) => {
  const user = requireUser()
  const session = getSession(params.id)
  if (!session || session.owner_id !== user.id) return fail('Upload session not found', 404)

  await fsp.rm(stagingDir(session.id), { recursive: true, force: true })
  db().prepare(`DELETE FROM upload_sessions WHERE id = ?`).run(session.id)

  audit({
    actorId: user.id,
    actorName: user.username,
    action: 'upload.abort',
    targetType: 'upload',
    targetId: session.id,
    detail: { filename: session.filename, receivedChunks: session.received_count },
  })

  return ok({ aborted: true })
})
