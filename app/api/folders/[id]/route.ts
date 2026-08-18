import { requireUser } from '@/lib/auth'
import { renameFolder, moveFolder, deleteFolder, getFolder, FolderError } from '@/lib/folders'
import { audit } from '@/lib/audit'
import { ok, fail, route, jsonBody } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface Params {
  params: Promise<{ id: string }>
}

interface PatchBody {
  name?: string
  /** `null` moves to the top level; omit the key to leave the parent alone. */
  parentId?: string | null
}

export const PATCH = route(async (req: Request, { params }: Params) => {
  const { id } = await params
  const user = await requireUser()
  const body = await jsonBody<PatchBody>(req)
  if (!body) return fail('Malformed request body')

  try {
    if (body.name !== undefined) renameFolder(id, user.id, body.name)
    if ('parentId' in body) moveFolder(id, user.id, body.parentId ?? null)

    audit({
      actorId: user.id,
      actorName: user.username,
      action: 'folder.update',
      targetType: 'folder',
      targetId: id,
      detail: body,
    })

    return ok({ folder: getFolder(id, user.id) })
  } catch (err) {
    if (err instanceof FolderError) return fail(err.message, err.status)
    throw err
  }
})

export const DELETE = route(async (req: Request, { params }: Params) => {
  const { id } = await params
  const user = await requireUser()
  const recursive = new URL(req.url).searchParams.get('recursive') === '1'

  try {
    deleteFolder(id, user.id, recursive)

    audit({
      actorId: user.id,
      actorName: user.username,
      action: 'folder.delete',
      targetType: 'folder',
      targetId: id,
      detail: { recursive },
    })

    // Files are lifted to the parent, never deleted with the folder.
    return ok({ deleted: true })
  } catch (err) {
    if (err instanceof FolderError) return fail(err.message, err.status)
    throw err
  }
})
