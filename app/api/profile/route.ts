import { requireUser } from '@/lib/auth'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { ok, fail, route, jsonBody } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface PatchBody {
  displayName?: string
  bio?: string
}

export const PATCH = route(async (req: Request) => {
  const user = await requireUser()
  const body = await jsonBody<PatchBody>(req)
  if (!body) return fail('Malformed request body')

  const updates: string[] = []
  const values: unknown[] = []

  if (body.displayName !== undefined) {
    // Strip control characters — these render in other people's browsers, and
    // bidi overrides in particular can be used to disguise a name entirely.
    // eslint-disable-next-line no-control-regex
    const name = body.displayName.replace(/[\x00-\x1f\x7f‪-‮⁦-⁩]/g, '').trim()
    if (name.length > 40) return fail('Display name must be 40 characters or fewer')
    updates.push('display_name = ?')
    values.push(name || null)
  }

  if (body.bio !== undefined) {
    // eslint-disable-next-line no-control-regex
    const bio = body.bio.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim()
    if (bio.length > 280) return fail('Bio must be 280 characters or fewer')
    updates.push('bio = ?')
    values.push(bio || null)
  }

  if (updates.length === 0) return fail('Nothing to update')

  values.push(user.id)
  db().prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values)

  audit({
    actorId: user.id,
    actorName: user.username,
    action: 'profile.update',
    targetType: 'user',
    targetId: user.id,
  })

  return ok({ updated: true })
})
