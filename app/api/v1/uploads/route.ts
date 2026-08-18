import { apiRoute, apiOk, apiFail, apiOptions } from '@/lib/apiauth'
import { clientCountry } from '@/lib/auth'
import { db } from '@/lib/db'
import { LIMITS } from '@/lib/config'
import { canAccept, diskHasRoomFor } from '@/lib/storage'
import { chunkPlan, newMask } from '@/lib/uploads'
import { getFolder } from '@/lib/folders'
import { newId } from '@/lib/ids'
import { audit } from '@/lib/audit'
import { sanitiseFileName } from '@/lib/filemeta'
import { jsonBody } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface InitBody {
  filename?: string
  sizeBytes?: number
  mime?: string
  folderId?: string | null
}

/**
 * POST /v1/uploads — open a chunked upload session.
 *
 * This is the path for files past the one-shot limit: the client declares the
 * total size here, uploads the bytes as chunks (PUT /v1/uploads/:id/chunks/:i),
 * then finalises (POST /v1/uploads/:id/complete). Declaring the size up front
 * lets quota be reserved before any bytes move.
 *
 * The API never touches encrypted folders — the server cannot screen what it
 * cannot read — so an encrypted destination is refused rather than uploaded to.
 */
export const POST = apiRoute(
  async (req, _ctx, { user }) => {
    const body = await jsonBody<InitBody>(req)
    if (!body) return apiFail('Malformed request body', 400)

    const filename = sanitiseFileName(body.filename ?? '')
    if (!filename) return apiFail('A filename is required', 400)

    const sizeBytes = Number(body.sizeBytes)
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
      return apiFail('sizeBytes must be a positive integer', 400)
    }

    const folderId = body.folderId || null
    if (folderId) {
      const folder = getFolder(folderId, user.id)
      if (!folder) return apiFail('Folder not found', 404)
      if (folder.encrypted) {
        return apiFail('The API cannot upload into encrypted folders', 409)
      }
    }

    const quota = canAccept(user.id, sizeBytes)
    if (!quota.ok) return apiFail(quota.reason, 413)

    // Quota can be overcommitted, so an account may have room while the disk
    // does not — check the disk too before reserving the session.
    if (!diskHasRoomFor(sizeBytes)) {
      return apiFail('The server is low on disk space right now — try again later', 507)
    }

    const { chunkBytes, totalChunks } = chunkPlan(sizeBytes)
    const id = newId()
    const now = Date.now()

    db()
      .prepare(
        `INSERT INTO upload_sessions
           (id, owner_id, filename, size_bytes, mime, chunk_bytes, total_chunks,
            received_mask, received_count, status, created_at, updated_at, expires_at,
            folder_id, enc_meta, country)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'open', ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        id,
        user.id,
        filename,
        sizeBytes,
        body.mime ?? null,
        chunkBytes,
        totalChunks,
        newMask(totalChunks),
        now,
        now,
        now + LIMITS.stagingTtlMs,
        folderId,
        clientCountry(),
      )

    audit({
      actorId: user.id,
      actorName: user.username,
      action: 'upload.init',
      targetType: 'upload',
      targetId: id,
      detail: { via: 'api', filename, sizeBytes, totalChunks },
    })

    return apiOk(
      {
        uploadId: id,
        chunkBytes,
        totalChunks,
        maxChunkBytes: LIMITS.maxChunkBytes,
        expiresAt: now + LIMITS.stagingTtlMs,
      },
      { status: 201 },
    )
  },
  { scope: 'write', limit: 'apiUpload' },
)

export const OPTIONS = apiOptions
