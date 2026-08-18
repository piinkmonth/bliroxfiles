import { requireUser } from '@/lib/auth'
import { ok, fail, route, jsonBody } from '@/lib/api'
import { createToken, listTokens, isScope } from '@/lib/apitokens'
import { tokenView } from '@/lib/apiviews'
import type { ApiScope } from '@/lib/db'
import { audit } from '@/lib/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** GET /api/profile/tokens — the caller's API tokens (safe view). */
export const GET = route(async () => {
  const user = await requireUser()
  return ok({ tokens: listTokens(user.id).map(tokenView) })
})

interface CreateBody {
  name?: string
  scopes?: unknown
  /** Absolute epoch-ms expiry, or null/omitted for a token that never expires. */
  expiresAt?: number | null
}

const MAX_NAME = 60

/**
 * POST /api/profile/tokens — mint a token.
 *
 * The raw secret is returned exactly once, in `token`. It is never stored in a
 * form we can recover, so the UI must show it now or never.
 */
export const POST = route(async (req: Request) => {
  const user = await requireUser()
  const body = await jsonBody<CreateBody>(req)
  if (!body) return fail('Malformed request body')

  const name = (body.name ?? '').trim()
  if (!name) return fail('A name is required')
  if (name.length > MAX_NAME) return fail(`Name must be ${MAX_NAME} characters or fewer`)

  if (!Array.isArray(body.scopes)) return fail('Pick at least one scope')
  const scopes = body.scopes.filter(isScope) as ApiScope[]
  if (scopes.length === 0) return fail('Pick at least one scope')

  let expiresAt: number | null = null
  if (body.expiresAt != null) {
    if (!Number.isInteger(body.expiresAt) || body.expiresAt <= Date.now()) {
      return fail('Expiry must be a future date')
    }
    expiresAt = body.expiresAt
  }

  const { token, row } = createToken(user.id, name, scopes, expiresAt)

  audit({
    actorId: user.id,
    actorName: user.username,
    action: 'token.create',
    targetType: 'token',
    targetId: row.id,
    // Never the secret — just what it is and what it can do.
    detail: { name, scopes, prefix: row.prefix, expiresAt },
  })

  return ok({ token, tokenInfo: tokenView(row) }, { status: 201 })
})
