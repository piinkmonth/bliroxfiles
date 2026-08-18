import { requireUser } from '@/lib/auth'
import { LIMITS } from '@/lib/config'
import { getSession, writeChunk, sessionStatus, expectedChunkSize } from '@/lib/uploads'
import { ok, fail, route } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Chunks stream straight to disk; nothing here should be cached or buffered.
export const fetchCache = 'force-no-store'
export const maxDuration = 3600

interface Params {
  params: Promise<{ id: string; index: string }>
}

/**
 * Receive one chunk of a file.
 *
 * Cloudflare Tunnel rejects request bodies over 100 MB, so this is the only
 * path by which a 15 GB file can reach the server: many bounded requests
 * instead of one enormous one. Each is independently retryable.
 */
export const PUT = route(async (req: Request, { params }: Params) => {
  const p = await params
  const user = await requireUser()

  const session = getSession(p.id)
  if (!session) return fail('Upload session not found — it may have expired', 404)
  if (session.owner_id !== user.id) return fail('Upload session not found', 404)

  if (session.status !== 'open') {
    return fail(`Upload session is ${session.status}, not accepting chunks`, 409)
  }
  if (session.expires_at < Date.now()) {
    return fail('Upload session expired', 410)
  }

  const index = Number(p.index)
  if (!Number.isInteger(index)) return fail('Chunk index must be an integer')

  // Reject oversized chunks on the declared length before reading the body,
  // so a bad client cannot make us stream gigabytes to find out.
  const declared = Number(req.headers.get('content-length') ?? '0')
  if (declared > LIMITS.maxChunkBytes) {
    return fail(
      `Chunk exceeds the ${Math.floor(LIMITS.maxChunkBytes / 1024 / 1024)} MB limit. ` +
        `Cloudflare Tunnel will not pass a body this large.`,
      413,
    )
  }

  const expected = expectedChunkSize(session, index)
  if (declared > 0 && declared !== expected) {
    return fail(`Chunk ${index} should be ${expected} bytes, got ${declared}`, 400)
  }

  if (!req.body) return fail('Request had no body')

  const result = await writeChunk(session, index, req.body)
  if (!result.ok) return fail(result.error, 400)

  const updated = getSession(p.id)
  return ok({
    index,
    alreadyHad: result.alreadyHad,
    received: updated?.received_count ?? 0,
    totalChunks: session.total_chunks,
    complete: (updated?.received_count ?? 0) === session.total_chunks,
  })
})

/** Per-chunk status, so a resuming client can verify a single part. */
export const GET = route(async (_req: Request, { params }: Params) => {
  const p = await params
  const user = await requireUser()
  const session = getSession(p.id)
  if (!session || session.owner_id !== user.id) return fail('Upload session not found', 404)
  return ok(sessionStatus(session))
})
