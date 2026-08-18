import fsp from 'node:fs/promises'
import { apiRoute, apiOk, apiFail, apiOptions } from '@/lib/apiauth'
import { hashPassword } from '@/lib/auth'
import { db, type FileRow, type UserRow } from '@/lib/db'
import { blobAbsPath, recomputeUsage } from '@/lib/storage'
import { getFolder } from '@/lib/folders'
import { deleteThumb } from '@/lib/preview'
import { fileView } from '@/lib/apiviews'
import {
  MAX_EXPIRY_MS,
  MAX_BURN_DOWNLOADS,
  MAX_NOTE_LENGTH,
  sanitiseFileName,
  sanitiseNote,
} from '@/lib/filemeta'
import { audit } from '@/lib/audit'
import { jsonBody } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface Ctx {
  params: { id: string }
}

/** Load a file the token owner owns. API access is owner-only — no staff path. */
function loadOwned(id: string, user: UserRow): FileRow | null {
  const file = db().prepare(`SELECT * FROM files WHERE id = ?`).get(id) as FileRow | undefined
  if (!file || file.deleted_at || file.owner_id !== user.id) return null
  return file
}

/** GET /v1/files/:id — metadata, share URL, and download stats. */
export const GET = apiRoute<Ctx>(
  async (_req, { params }, { user }) => {
    const file = loadOwned(params.id, user)
    if (!file) return apiFail('File not found', 404)
    return apiOk({ file: fileView(file) })
  },
  { scope: 'read', limit: 'apiRead' },
)

interface PatchBody {
  name?: string
  visibility?: 'unlisted' | 'private'
  folderId?: string | null
  sharePassword?: string | null
  anonymous?: boolean
  expiresAt?: number | null
  burnAfter?: number | null
  note?: string | null
}

/**
 * PATCH /v1/files/:id — edit file metadata.
 *
 * Mirrors the web edit route's rules (same shared limits in lib/filemeta.ts).
 * Encrypted-file specifics (publishing a passphrase link) are deliberately not
 * exposed here; the encrypted rules below refuse the operations that would
 * conflict, matching the web route.
 */
export const PATCH = apiRoute<Ctx>(
  async (req, { params }, { user }) => {
    const file = loadOwned(params.id, user)
    if (!file) return apiFail('File not found', 404)

    const body = await jsonBody<PatchBody>(req)
    if (!body) return apiFail('Malformed request body', 400)

    const updates: string[] = []
    const values: unknown[] = []

    if (body.visibility !== undefined) {
      if (body.visibility !== 'unlisted' && body.visibility !== 'private') {
        return apiFail('visibility must be "unlisted" or "private"', 400)
      }
      if (body.visibility === 'unlisted' && file.encrypted) {
        return apiFail('Encrypted files cannot be shared through the API', 409)
      }
      updates.push('visibility = ?')
      values.push(body.visibility)
    }

    if ('folderId' in body) {
      const folderId = body.folderId ?? null
      if (folderId) {
        const folder = getFolder(folderId, file.owner_id)
        if (!folder) return apiFail('Folder not found', 404)
        if (Boolean(folder.encrypted) !== Boolean(file.encrypted)) {
          return apiFail('Cannot move between encrypted and unencrypted folders', 409)
        }
      } else if (file.encrypted) {
        return apiFail('Encrypted files must stay in an encrypted folder', 409)
      }
      updates.push('folder_id = ?')
      values.push(folderId)
    }

    if (body.name !== undefined) {
      const name = sanitiseFileName(body.name)
      if (!name) return apiFail('Name cannot be empty', 400)
      updates.push('name = ?')
      values.push(name)
    }

    if (body.sharePassword !== undefined) {
      if (body.sharePassword === null || body.sharePassword === '') {
        updates.push('password_hash = ?')
        values.push(null)
      } else {
        if (body.sharePassword.length < 6) {
          return apiFail('Share password must be at least 6 characters', 400)
        }
        if (file.encrypted) {
          return apiFail('Encrypted files have no share link to protect', 409)
        }
        updates.push('password_hash = ?')
        values.push(hashPassword(body.sharePassword))
      }
    }

    if (body.anonymous !== undefined) {
      updates.push('anonymous = ?')
      values.push(body.anonymous ? 1 : 0)
    }

    if (body.expiresAt !== undefined) {
      if (body.expiresAt === null) {
        updates.push('expires_at = ?')
        values.push(null)
      } else {
        const at = Number(body.expiresAt)
        if (!Number.isFinite(at)) return apiFail('expiresAt must be a timestamp or null', 400)
        if (at < Date.now() - 60_000) return apiFail('That expiry is in the past', 400)
        if (at > Date.now() + MAX_EXPIRY_MS) {
          return apiFail('Expiry cannot be more than a year out', 400)
        }
        updates.push('expires_at = ?')
        values.push(Math.round(at))
      }
    }

    if (body.burnAfter !== undefined) {
      if (body.burnAfter === null) {
        updates.push('burn_after = ?')
        values.push(null)
      } else {
        const n = Number(body.burnAfter)
        if (!Number.isInteger(n) || n < 1 || n > MAX_BURN_DOWNLOADS) {
          return apiFail(`burnAfter must be between 1 and ${MAX_BURN_DOWNLOADS}, or null`, 400)
        }
        if (file.encrypted) {
          return apiFail('Download limits do not apply to encrypted files', 409)
        }
        updates.push('burn_after = ?')
        values.push(n)
      }
    }

    if (body.note !== undefined) {
      if (body.note === null || body.note.trim() === '') {
        updates.push('note = ?')
        values.push(null)
      } else {
        const note = sanitiseNote(body.note)
        if (note.length > MAX_NOTE_LENGTH) {
          return apiFail(`Note must be ${MAX_NOTE_LENGTH} characters or fewer`, 400)
        }
        updates.push('note = ?')
        values.push(note)
      }
    }

    if (updates.length === 0) return apiFail('Nothing to update', 400)

    values.push(file.id)
    db().prepare(`UPDATE files SET ${updates.join(', ')} WHERE id = ?`).run(...values)

    audit({
      actorId: user.id,
      actorName: user.username,
      action: 'file.update',
      targetType: 'file',
      targetId: file.id,
      detail: {
        via: 'api',
        ...body,
        ...(body.sharePassword !== undefined
          ? { sharePassword: body.sharePassword ? '[set]' : '[removed]' }
          : {}),
      },
    })

    const updated = db().prepare(`SELECT * FROM files WHERE id = ?`).get(file.id) as FileRow
    return apiOk({ file: fileView(updated) })
  },
  { scope: 'write', limit: 'apiWrite' },
)

/**
 * DELETE /v1/files/:id — delete a file and reclaim its quota.
 *
 * The blob is removed and the row soft-deleted, exactly as the web route does,
 * so the hash and audit trail survive a delete.
 */
export const DELETE = apiRoute<Ctx>(
  async (_req, { params }, { user }) => {
    const file = loadOwned(params.id, user)
    if (!file) return apiFail('File not found', 404)

    if (file.status === 'quarantined') {
      return apiFail('This file is under review and cannot be deleted', 409)
    }

    await fsp.rm(blobAbsPath(file.storage_path), { force: true }).catch((err) => {
      console.error('[api/files] blob removal failed', file.id, err)
    })
    await deleteThumb(file)

    db()
      .prepare(`UPDATE files SET status = 'removed', deleted_at = ? WHERE id = ?`)
      .run(Date.now(), file.id)

    recomputeUsage(file.owner_id)

    audit({
      actorId: user.id,
      actorName: user.username,
      action: 'file.delete',
      targetType: 'file',
      targetId: file.id,
      detail: { via: 'api', name: file.name, sizeBytes: file.size_bytes },
    })

    return apiOk({ deleted: true })
  },
  { scope: 'delete', limit: 'apiWrite' },
)

export const OPTIONS = apiOptions
