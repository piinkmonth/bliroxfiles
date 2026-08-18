import { requireUser } from '@/lib/auth'
import { createFolder, listFolder, allFolders, FolderError } from '@/lib/folders'
import { audit } from '@/lib/audit'
import { ok, fail, route, jsonBody } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = route(async (req: Request) => {
  const user = requireUser()
  const url = new URL(req.url)

  if (url.searchParams.get('all') === '1') {
    return ok({ folders: allFolders(user.id) })
  }

  try {
    return ok(listFolder(user.id, url.searchParams.get('parent') || null))
  } catch (err) {
    if (err instanceof FolderError) return fail(err.message, err.status)
    throw err
  }
})

interface CreateBody {
  name?: string
  parentId?: string | null
  encryption?: { kdfSalt: string; kdfParams: string; verifier: string } | null
}

export const POST = route(async (req: Request) => {
  const user = requireUser()
  const body = await jsonBody<CreateBody>(req)
  if (!body?.name) return fail('A folder name is required')

  try {
    const folder = createFolder({
      ownerId: user.id,
      name: body.name,
      parentId: body.parentId ?? null,
      encryption: body.encryption ?? null,
    })

    audit({
      actorId: user.id,
      actorName: user.username,
      action: 'folder.create',
      targetType: 'folder',
      targetId: folder.id,
      detail: { name: folder.name, encrypted: !!folder.encrypted },
    })

    return ok({ folder })
  } catch (err) {
    if (err instanceof FolderError) return fail(err.message, err.status)
    throw err
  }
}, { limit: 'folderCreate' })
