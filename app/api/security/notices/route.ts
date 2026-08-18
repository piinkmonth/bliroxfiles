import { requireUser, acknowledgeNotices } from '@/lib/auth'
import { ok, fail, route, jsonBody } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Mark security notices as seen.
 *
 * Scoped to the caller's own rows in the query itself, so a forged id belonging
 * to somebody else updates nothing rather than being rejected — there is no
 * need to tell the caller whether the id existed.
 */
export const POST = route(async (req: Request) => {
  const user = await requireUser()
  const body = await jsonBody<{ ids?: unknown }>(req)

  const ids = Array.isArray(body?.ids)
    ? body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 50)
    : []

  if (ids.length === 0) return fail('No notice ids given')

  acknowledgeNotices(user.id, ids)
  return ok({ acknowledged: ids.length })
}, { limit: 'mutation' })
