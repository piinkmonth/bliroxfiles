import { requireUser } from '@/lib/auth'
import { db } from '@/lib/db'
import {
  listCollaborators,
  addCollaborator,
  removeCollaborator,
  CollabError,
} from '@/lib/collab'
import { ok, fail, route, jsonBody } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface Params {
  params: { id: string }
}

/** Owner-only: seeing who else has a folder is itself owner information. */
function requireOwnedFolder(folderId: string, userId: string) {
  const folder = db()
    .prepare(`SELECT id, encrypted FROM folders WHERE id = ? AND owner_id = ?`)
    .get(folderId, userId) as { id: string; encrypted: number } | undefined
  if (!folder) throw new CollabError('Folder not found', 404)
  return folder
}

export const GET = route(async (_req: Request, { params }: Params) => {
  const user = requireUser()
  try {
    requireOwnedFolder(params.id, user.id)
    return ok({ collaborators: listCollaborators(params.id) })
  } catch (err) {
    if (err instanceof CollabError) return fail(err.message, err.status)
    throw err
  }
})

interface PostBody {
  username?: string
  role?: 'viewer' | 'contributor'
}

export const POST = route(async (req: Request, { params }: Params) => {
  const user = requireUser()
  const body = await jsonBody<PostBody>(req)

  const username = (body?.username ?? '').trim()
  if (!username) return fail('A username is required')

  const role = body?.role === 'contributor' ? 'contributor' : 'viewer'

  try {
    const collaborator = addCollaborator({
      folderId: params.id,
      ownerId: user.id,
      ownerName: user.username,
      username,
      role,
    })
    return ok({ collaborator })
  } catch (err) {
    if (err instanceof CollabError) return fail(err.message, err.status)
    throw err
  }
}, { limit: 'mutation' })

export const DELETE = route(async (req: Request, { params }: Params) => {
  const user = requireUser()
  const userId = new URL(req.url).searchParams.get('userId')
  if (!userId) return fail('userId is required')

  try {
    removeCollaborator({
      folderId: params.id,
      ownerId: user.id,
      ownerName: user.username,
      userId,
    })
    return ok({ removed: true })
  } catch (err) {
    if (err instanceof CollabError) return fail(err.message, err.status)
    throw err
  }
}, { limit: 'mutation' })
