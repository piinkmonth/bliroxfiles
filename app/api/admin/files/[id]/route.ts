import { requireRole, clientIpForStorage } from '@/lib/auth'
import { db, type FileRow } from '@/lib/db'
import { audit } from '@/lib/audit'
import { ok, fail, route, jsonBody } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface PatchBody {
  /** Staff vouching that a file is what it claims to be. */
  verified?: boolean
  note?: string
}

/**
 * Mark a file verified, or withdraw that.
 *
 * Verification is a staff statement to downloaders that someone looked at this
 * and it is what it says it is — useful when the whole point of a link is that
 * a stranger has to decide whether to trust it. It is deliberately not
 * automatic: a clean virus scan is not the same claim.
 */
export const PATCH = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params
  const staff = await requireRole('mod')

  const file = db().prepare(`SELECT * FROM files WHERE id = ?`).get(id) as
    | FileRow
    | undefined
  if (!file) return fail('File not found', 404)

  const body = await jsonBody<PatchBody>(req)
  if (!body || body.verified === undefined) return fail('Nothing to update')

  if (file.status !== 'active') {
    return fail('Only active files can be verified', 409)
  }
  if (file.encrypted) {
    // Nobody can see inside an encrypted file, so nobody can vouch for it.
    return fail('Encrypted files cannot be verified — their contents are unreadable', 409)
  }

  const now = Date.now()
  if (body.verified) {
    db()
      .prepare(
        `UPDATE files SET verified_at = ?, verified_by = ?, verified_note = ? WHERE id = ?`,
      )
      .run(now, staff.id, (body.note ?? '').slice(0, 200) || null, file.id)
  } else {
    db()
      .prepare(`UPDATE files SET verified_at = NULL, verified_by = NULL, verified_note = NULL WHERE id = ?`)
      .run(file.id)
  }

  audit({
    actorId: staff.id,
    actorName: staff.username,
    action: body.verified ? 'file.verify' : 'file.unverify',
    targetType: 'file',
    targetId: file.id,
    ip: await clientIpForStorage(),
    detail: { name: file.name, note: body.note },
  })

  return ok({ verified: !!body.verified })
})
