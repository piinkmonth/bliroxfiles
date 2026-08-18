import fsp from 'node:fs/promises'
import { requireUser, hasRole, hashPassword } from '@/lib/auth'
import { db, type FileRow } from '@/lib/db'
import { blobAbsPath, recomputeUsage } from '@/lib/storage'
import { getFolder } from '@/lib/folders'
import { deleteThumb } from '@/lib/preview'
import {
  MAX_EXPIRY_MS,
  MAX_BURN_DOWNLOADS,
  MAX_NOTE_LENGTH,
  sanitiseFileName,
  sanitiseNote,
} from '@/lib/filemeta'
import { audit } from '@/lib/audit'
import { ok, fail, route, jsonBody } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface Params {
  params: { id: string }
}

function loadOwned(id: string, userId: string, isStaff: boolean): FileRow | null {
  const file = db().prepare(`SELECT * FROM files WHERE id = ?`).get(id) as FileRow | undefined
  if (!file || file.deleted_at) return null
  if (file.owner_id !== userId && !isStaff) return null
  return file
}

/**
 * Delete a file and reclaim its quota.
 *
 * The blob is removed and the row is soft-deleted rather than dropped — the
 * hash and the audit trail have to survive so a file that was deleted right
 * after being reported can still be tied back to its uploader.
 */
export const DELETE = route(async (_req: Request, { params }: Params) => {
  const user = requireUser()
  const file = loadOwned(params.id, user.id, hasRole(user, 'mod'))
  if (!file) return fail('File not found', 404)

  if (file.status === 'quarantined') {
    return fail('This file is under review and cannot be deleted', 409)
  }

  await fsp.rm(blobAbsPath(file.storage_path), { force: true }).catch((err) => {
    console.error('[files] blob removal failed', file.id, err)
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
    detail: { name: file.name, sizeBytes: file.size_bytes, byStaff: file.owner_id !== user.id },
  })

  return ok({ deleted: true })
})

interface PatchBody {
  name?: string
  visibility?: 'unlisted' | 'private'
  /** `null` moves the file back to the top level. */
  folderId?: string | null
  /** A string sets a share password; null removes it. */
  sharePassword?: string | null
  /** Hides the uploader on the public page. */
  anonymous?: boolean
  /** Publishes (or withdraws) a passphrase-gated link for an encrypted file. */
  encShare?: boolean
  /** Epoch ms the link stops working, or null for never. */
  expiresAt?: number | null
  /** Downloads remaining before the file destroys itself, or null for no limit. */
  burnAfter?: number | null
  /** Short description shown on the share page. */
  note?: string | null
}

export const PATCH = route(async (req: Request, { params }: Params) => {
  const user = requireUser()
  const file = loadOwned(params.id, user.id, hasRole(user, 'mod'))
  if (!file) return fail('File not found', 404)

  const body = await jsonBody<PatchBody>(req)
  if (!body) return fail('Malformed request body')

  const updates: string[] = []
  const values: unknown[] = []

  if (body.visibility !== undefined) {
    if (body.visibility !== 'unlisted' && body.visibility !== 'private') {
      return fail('visibility must be "unlisted" or "private"')
    }
    // An encrypted file's visibility is driven by `encShare` below, not set
    // directly — the two would otherwise be able to disagree, leaving a file
    // marked as having a published link that the download route refuses to
    // serve, or the reverse.
    if (body.visibility === 'unlisted' && file.encrypted) {
      return fail('Use encShare to publish a link for an encrypted file', 409)
    }
    updates.push('visibility = ?')
    values.push(body.visibility)
  }

  if (body.encShare !== undefined) {
    if (!file.encrypted) return fail('That file is not encrypted', 400)
    // Owner only, deliberately not staff. Publishing a link is a disclosure
    // decision about content nobody but the owner can read, so it is not one a
    // moderator is in any position to make on their behalf.
    if (file.owner_id !== user.id) return fail('Only the owner can share this file', 403)
    if (body.encShare && !file.folder_id) {
      return fail('An encrypted file needs its folder to derive the passphrase from', 409)
    }

    updates.push('enc_share = ?', 'visibility = ?')
    values.push(body.encShare ? 1 : 0, body.encShare ? 'unlisted' : 'private')
  }

  if ('folderId' in body) {
    const folderId = body.folderId ?? null
    if (folderId) {
      const folder = getFolder(folderId, file.owner_id)
      if (!folder) return fail('Folder not found', 404)
      // Moving a plain file into an encrypted folder would sit unencrypted
      // among encrypted ones and quietly break the folder's guarantee.
      if (Boolean(folder.encrypted) !== Boolean(file.encrypted)) {
        return fail('Cannot move between encrypted and unencrypted folders', 409)
      }
    } else if (file.encrypted) {
      return fail('Encrypted files must stay in an encrypted folder', 409)
    }
    updates.push('folder_id = ?')
    values.push(folderId)
  }

  if (body.name !== undefined) {
    const name = sanitiseFileName(body.name)
    if (!name) return fail('Name cannot be empty')
    updates.push('name = ?')
    values.push(name)
  }

  if (body.sharePassword !== undefined) {
    if (body.sharePassword === null || body.sharePassword === '') {
      updates.push('password_hash = ?')
      values.push(null)
    } else {
      if (body.sharePassword.length < 6) {
        return fail('Share password must be at least 6 characters')
      }
      if (file.encrypted) {
        return fail('Encrypted files have no share link to protect', 409)
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
      if (!Number.isFinite(at)) return fail('expiresAt must be a timestamp or null')
      // A moment ago is a plausible clock skew; an hour ago is a mistake, and
      // setting a link to have already expired is never what someone wants.
      if (at < Date.now() - 60_000) return fail('That expiry is in the past')
      if (at > Date.now() + MAX_EXPIRY_MS) return fail('Expiry cannot be more than a year out')
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
        return fail(`burnAfter must be between 1 and ${MAX_BURN_DOWNLOADS}, or null`)
      }
      // An encrypted file's bytes are fetched once per decrypt attempt, so a
      // budget of one would burn it on a mistyped passphrase.
      if (file.encrypted) {
        return fail('Download limits do not apply to encrypted files', 409)
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
        return fail(`Note must be ${MAX_NOTE_LENGTH} characters or fewer`)
      }
      updates.push('note = ?')
      values.push(note)
    }
  }

  if (updates.length === 0) return fail('Nothing to update')

  values.push(file.id)
  db().prepare(`UPDATE files SET ${updates.join(', ')} WHERE id = ?`).run(...values)

  audit({
    actorId: user.id,
    actorName: user.username,
    action: 'file.update',
    targetType: 'file',
    targetId: file.id,
    // Never the body verbatim: it can carry `sharePassword`, and the audit
    // trail is the one table specifically meant to be read by a human later.
    // What was changed is the useful record; what it was changed *to* is only
    // useful for the fields that are not secrets.
    detail: {
      ...body,
      ...(body.sharePassword !== undefined
        ? { sharePassword: body.sharePassword ? '[set]' : '[removed]' }
        : {}),
    },
  })

  return ok({ updated: true })
})
