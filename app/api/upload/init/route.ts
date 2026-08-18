import { requireUser, clientCountry } from '@/lib/auth'
import { db } from '@/lib/db'
import { LIMITS } from '@/lib/config'
import { canAccept, diskHasRoomFor, formatBytes } from '@/lib/storage'
import { chunkPlan, newMask } from '@/lib/uploads'
import { accessibleFolder, atLeast } from '@/lib/collab'
import { newId } from '@/lib/ids'
import { audit } from '@/lib/audit'
import { ok, fail, route, jsonBody } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface InitBody {
  filename?: string
  sizeBytes?: number
  mime?: string
  folderId?: string | null
  /** Present when the client encrypted the bytes before upload. */
  encMeta?: string | null
}

/**
 * Open a chunked upload session.
 *
 * The client declares the size up front so quota can be reserved before any
 * bytes move — refusing a 15 GB upload at byte zero rather than at byte
 * 14,999,999,999.
 */
export const POST = route(async (req: Request) => {
  const user = await requireUser()
  const body = await jsonBody<InitBody>(req)
  if (!body) return fail('Malformed request body')

  const filename = sanitiseFilename(body.filename ?? '')
  if (!filename) return fail('A filename is required')

  const sizeBytes = Number(body.sizeBytes)
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    return fail('sizeBytes must be a positive integer')
  }

  // Validate the destination before reserving anything.
  //
  // A folder shared with you is a legitimate destination if you were given the
  // contributor role — a viewer can read what is there and nothing more.
  // Quota is still charged to the uploader below, not to the folder's owner:
  // whoever put the bytes on the disk pays for them.
  const folderId = body.folderId || null
  let folderEncrypted = false
  if (folderId) {
    const found = accessibleFolder(folderId, user.id)
    if (!found) return fail('Folder not found', 404)
    if (!atLeast(found.access, 'contributor')) {
      return fail('You can view this folder but not add to it', 403)
    }
    folderEncrypted = !!found.folder.encrypted
  }

  if (folderEncrypted && !body.encMeta) {
    return fail('That folder is encrypted — the file must be encrypted before upload', 400)
  }
  if (!folderEncrypted && body.encMeta) {
    return fail('Encrypted files can only go in an encrypted folder', 400)
  }

  const quota = canAccept(user.id, sizeBytes)
  if (!quota.ok) return fail(quota.reason, 413)

  // Overcommitted quota means an account can have space while the disk does not.
  if (!diskHasRoomFor(sizeBytes)) {
    return fail('The server is low on disk space right now — try again later', 507)
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
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'open', ?, ?, ?, ?, ?, ?)`,
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
      body.encMeta ?? null,
      await clientCountry(),
    )

  audit({
    actorId: user.id,
    actorName: user.username,
    action: 'upload.init',
    targetType: 'upload',
    targetId: id,
    detail: { filename, sizeBytes: formatBytes(sizeBytes), totalChunks },
  })

  return ok({
    uploadId: id,
    chunkBytes,
    totalChunks,
    expiresAt: now + LIMITS.stagingTtlMs,
  })
}, { limit: 'uploadInit' })

/**
 * Strip directory components and control characters from a client-supplied
 * filename. This is display metadata only — it never touches a real path,
 * since blobs are stored under generated ids — but it still ends up rendered
 * in pages and Content-Disposition headers.
 */
function sanitiseFilename(raw: string): string {
  const base = raw.split(/[/\\]/).pop() ?? ''
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\x00-\x1f\x7f]/g, '').trim()
  return cleaned.slice(0, 255)
}
