import { apiRoute, apiOk, apiFail, apiOptions } from '@/lib/apiauth'
import { LIMITS } from '@/lib/config'
import { getSession, writeChunk, expectedChunkSize } from '@/lib/uploads'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Chunks stream straight to disk; nothing here should be cached or buffered.
export const fetchCache = 'force-no-store'
export const maxDuration = 3600

/**
 * PUT /v1/uploads/:id/chunks/:index — receive one chunk.
 *
 * The chunk size the session declared at init is the size expected here; the
 * last chunk is the partial remainder. Re-sending a chunk that already landed
 * is a no-op (`alreadyHad: true`), so a client can retry a chunk freely.
 */
export const PUT = apiRoute<{ id: string; index: string }>(
  async (req, { params }, { user }) => {
    const session = getSession(params.id)
    if (!session) return apiFail('Upload session not found — it may have expired', 404)
    if (session.owner_id !== user.id) return apiFail('Upload session not found', 404)

    if (session.status !== 'open') {
      return apiFail(`Upload session is ${session.status}, not accepting chunks`, 409)
    }
    if (session.expires_at < Date.now()) {
      return apiFail('Upload session expired', 410)
    }

    const index = Number(params.index)
    if (!Number.isInteger(index)) return apiFail('Chunk index must be an integer', 400)

    // Refuse an oversized chunk on its declared length, before reading a byte —
    // a body over this size would be rejected by the tunnel anyway.
    const declared = Number(req.headers.get('content-length') ?? '0')
    if (declared > LIMITS.maxChunkBytes) {
      return apiFail(
        `Chunk exceeds the ${Math.floor(LIMITS.maxChunkBytes / 1024 / 1024)} MB limit`,
        413,
      )
    }

    const expected = expectedChunkSize(session, index)
    if (declared > 0 && declared !== expected) {
      return apiFail(`Chunk ${index} should be ${expected} bytes, got ${declared}`, 400)
    }

    if (!req.body) return apiFail('Request had no body', 400)

    const result = await writeChunk(session, index, req.body)
    if (!result.ok) return apiFail(result.error, 400)

    const updated = getSession(params.id)
    return apiOk({
      index,
      alreadyHad: result.alreadyHad,
      received: updated?.received_count ?? 0,
      totalChunks: session.total_chunks,
      complete: (updated?.received_count ?? 0) === session.total_chunks,
    })
  },
  { scope: 'write', limit: 'apiChunk' },
)

export const OPTIONS = apiOptions
