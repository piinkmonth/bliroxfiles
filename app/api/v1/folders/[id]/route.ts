import { apiRoute, apiOk, apiFail, apiOptions } from '@/lib/apiauth'
import {
  getFolder,
  renameFolder,
  moveFolder,
  deleteFolder,
  FolderError,
} from '@/lib/folders'
import { folderView } from '@/lib/apiviews'
import { audit } from '@/lib/audit'
import { jsonBody } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Load a plain folder the token owner owns. Encrypted folders are refused: the
 * API cannot read or operate on end-to-end encrypted content.
 */
function loadPlain(
  id: string,
  userId: string,
): { ok: true; folder: ReturnType<typeof getFolder> } | { ok: false; status: number; error: string } {
  const folder = getFolder(id, userId)
  if (!folder) return { ok: false, status: 404, error: 'Folder not found' }
  if (folder.encrypted) {
    return { ok: false, status: 409, error: 'Encrypted folders are not accessible through the API' }
  }
  return { ok: true, folder }
}

/** GET /v1/folders/:id — folder metadata. */
export const GET = apiRoute<{ id: string }>(
  async (_req, { params }, { user }) => {
    const loaded = loadPlain(params.id, user.id)
    if (!loaded.ok) return apiFail(loaded.error, loaded.status)
    return apiOk({ folder: folderView(loaded.folder!) })
  },
  { scope: 'read', limit: 'apiRead' },
)

interface PatchBody {
  name?: string
  /** `null` moves the folder to the top level. */
  parentId?: string | null
}

/** PATCH /v1/folders/:id — rename and/or move. */
export const PATCH = apiRoute<{ id: string }>(
  async (req, { params }, { user }) => {
    const loaded = loadPlain(params.id, user.id)
    if (!loaded.ok) return apiFail(loaded.error, loaded.status)

    const body = await jsonBody<PatchBody>(req)
    if (!body) return apiFail('Malformed request body', 400)
    if (body.name === undefined && !('parentId' in body)) {
      return apiFail('Nothing to update', 400)
    }

    try {
      if (body.name !== undefined) {
        renameFolder(params.id, user.id, body.name)
      }
      if ('parentId' in body) {
        moveFolder(params.id, user.id, body.parentId ?? null)
      }
    } catch (err) {
      if (err instanceof FolderError) return apiFail(err.message, err.status)
      throw err
    }

    audit({
      actorId: user.id,
      actorName: user.username,
      action: 'folder.update',
      targetType: 'folder',
      targetId: params.id,
      detail: { via: 'api', ...body },
    })

    const updated = getFolder(params.id, user.id)!
    return apiOk({ folder: folderView(updated) })
  },
  { scope: 'write', limit: 'apiWrite' },
)

/**
 * DELETE /v1/folders/:id — delete a folder.
 *
 * Files inside are lifted to the parent, never destroyed. Pass `?recursive=1`
 * to remove a folder that still has subfolders.
 */
export const DELETE = apiRoute<{ id: string }>(
  async (req, { params }, { user }) => {
    const loaded = loadPlain(params.id, user.id)
    if (!loaded.ok) return apiFail(loaded.error, loaded.status)

    const recursive = ['1', 'true'].includes(
      (new URL(req.url).searchParams.get('recursive') ?? '').toLowerCase(),
    )

    try {
      deleteFolder(params.id, user.id, recursive)
    } catch (err) {
      if (err instanceof FolderError) return apiFail(err.message, err.status)
      throw err
    }

    audit({
      actorId: user.id,
      actorName: user.username,
      action: 'folder.delete',
      targetType: 'folder',
      targetId: params.id,
      detail: { via: 'api', name: loaded.folder!.name, recursive },
    })

    return apiOk({ deleted: true })
  },
  { scope: 'delete', limit: 'apiWrite' },
)

export const OPTIONS = apiOptions
