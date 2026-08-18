import { requireUser } from '@/lib/auth'
import { getSession } from '@/lib/uploads'
import { finalizeSession } from '@/lib/publish'
import { ok, fail, route } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 3600

interface Params {
  params: { id: string }
}

/**
 * Finalise a chunked upload: assemble, screen, and publish.
 *
 * The work — and the screening invariant — lives in `finalizeSession`
 * ([lib/publish.ts](lib/publish.ts)), shared with the API upload routes so a
 * single code path owns blocklist and malware screening. This route only
 * authenticates, loads and owns the session, and maps the result.
 */
export const POST = route(async (_req: Request, { params }: Params) => {
  const user = requireUser()

  const session = getSession(params.id)
  if (!session) return fail('Upload session not found — it may have expired', 404)
  if (session.owner_id !== user.id) return fail('Upload session not found', 404)

  const result = await finalizeSession(user, session)
  if (!result.ok) return fail(result.error, result.status, result.extra)

  return result.duplicate
    ? ok({ fileId: result.fileId, slug: result.slug, url: result.url, duplicate: true })
    : ok({
        fileId: result.fileId,
        slug: result.slug,
        url: result.url,
        name: result.name,
        sizeBytes: result.sizeBytes,
        duplicate: false,
      })
})
