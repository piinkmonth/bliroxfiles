import { apiRoute, apiOk, apiFail, apiOptions } from '@/lib/apiauth'
import {
  createFolder,
  listFolder,
  getFolder,
  FolderError,
} from '@/lib/folders'
import { folderView } from '@/lib/apiviews'
import { audit } from '@/lib/audit'
import { jsonBody } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /v1/folders — list folders directly under `parent` (or the top level).
 *
 * The API's world is plain folders only: encrypted folders are end-to-end
 * encrypted, so the server cannot read their names or contents and they are
 * filtered out here. Files inside a folder come from GET /v1/files?folder=:id.
 */
export const GET = apiRoute(
  async (req, _ctx, { user }) => {
    const parent = new URL(req.url).searchParams.get('parent')
    const parentId = parent && parent !== 'root' ? parent : null

    try {
      if (parentId) {
        const folder = getFolder(parentId, user.id)
        if (!folder) return apiFail('Folder not found', 404)
        if (folder.encrypted) {
          return apiFail('Encrypted folders are not accessible through the API', 409)
        }
      }

      const listing = listFolder(user.id, parentId)
      const folders = listing.folders.filter((f) => !f.encrypted).map(folderView)
      return apiOk({ folders })
    } catch (err) {
      if (err instanceof FolderError) return apiFail(err.message, err.status)
      throw err
    }
  },
  { scope: 'read', limit: 'apiRead' },
)

interface CreateBody {
  name?: string
  parentId?: string | null
}

/** POST /v1/folders — create a plain folder. */
export const POST = apiRoute(
  async (req, _ctx, { user }) => {
    const body = await jsonBody<CreateBody>(req)
    if (!body || typeof body.name !== 'string') return apiFail('A folder name is required', 400)

    const parentId = body.parentId || null
    if (parentId) {
      const parent = getFolder(parentId, user.id)
      if (!parent) return apiFail('Parent folder not found', 404)
      if (parent.encrypted) {
        return apiFail('The API cannot create folders inside encrypted folders', 409)
      }
    }

    try {
      // encryption: null — the API only ever makes plain folders.
      const folder = createFolder({ ownerId: user.id, name: body.name, parentId, encryption: null })

      audit({
        actorId: user.id,
        actorName: user.username,
        action: 'folder.create',
        targetType: 'folder',
        targetId: folder.id,
        detail: { via: 'api', name: folder.name, parentId },
      })

      return apiOk({ folder: folderView(folder) }, { status: 201 })
    } catch (err) {
      if (err instanceof FolderError) return apiFail(err.message, err.status)
      throw err
    }
  },
  { scope: 'write', limit: 'apiWrite' },
)

export const OPTIONS = apiOptions
