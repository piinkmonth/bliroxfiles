import { db, type FolderRow, type FileRow, type CollaboratorRole } from './db'
import { MAX_DEPTH } from './folders'
import { audit } from './audit'

/**
 * Shared access to encrypted folders.
 *
 * What a collaborator row actually grants is *reach*: the right to see that a
 * folder exists, list what is in it, and fetch the ciphertext. It grants no
 * ability to read anything. The key is derived from the folder passphrase in
 * the collaborator's own browser, and the passphrase travels between people
 * out of band — over a channel this server is not part of and cannot observe.
 *
 * Two consequences worth being explicit about, because they are easy to get
 * wrong when reasoning about this later:
 *
 * - **The server still cannot read a shared folder.** Sharing changes who may
 *   ask for the bytes, not what the bytes are. Blocklist screening and malware
 *   scanning remain impossible on them, exactly as for an unshared one.
 *
 * - **Revoking is not un-telling.** Removing a collaborator stops them
 *   fetching anything further. Whatever they already downloaded and decrypted
 *   is theirs, and they still know the passphrase — which is why the UI offers
 *   to rotate it rather than implying that revocation undoes access.
 *
 * Restricted to encrypted folders on purpose. A shared *plain* folder would be
 * readable content served to a second account with no separate accountability
 * trail for it, which is a moderation problem this design does not take on.
 */

export class CollabError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

/** Ordered weakest to strongest, so comparisons can be numeric. */
const RANK: Record<CollaboratorRole | 'owner', number> = {
  viewer: 0,
  contributor: 1,
  owner: 2,
}

export type Access = CollaboratorRole | 'owner'

export function atLeast(access: Access | null, min: Access): boolean {
  if (!access) return false
  return RANK[access] >= RANK[min]
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * What a user may do with a folder, or null if they may do nothing.
 *
 * Walks up the parent chain: a collaborator on an encrypted folder is a
 * collaborator on everything nested inside it, which is what "shared this
 * folder with you" means to the person being told it. Depth-capped for the
 * same reason `folderPath` is — a cycle from a bad write must not spin.
 */
export function folderAccess(folderId: string, userId: string): Access | null {
  const seen = new Set<string>()
  let cursor: string | null = folderId

  for (let depth = 0; cursor && depth <= MAX_DEPTH + 1; depth++) {
    if (seen.has(cursor)) break
    seen.add(cursor)

    const row = db()
      .prepare(`SELECT id, owner_id, parent_id FROM folders WHERE id = ?`)
      .get(cursor) as { id: string; owner_id: string; parent_id: string | null } | undefined
    if (!row) return null

    if (row.owner_id === userId) return 'owner'

    const grant = db()
      .prepare(`SELECT role FROM folder_collaborators WHERE folder_id = ? AND user_id = ?`)
      .get(row.id, userId) as { role: CollaboratorRole } | undefined
    if (grant) return grant.role

    cursor = row.parent_id
  }

  return null
}

/** The folder row, if this user may see it at all. */
export function accessibleFolder(
  folderId: string,
  userId: string,
): { folder: FolderRow; access: Access } | null {
  const access = folderAccess(folderId, userId)
  if (!access) return null

  const folder = db().prepare(`SELECT * FROM folders WHERE id = ?`).get(folderId) as
    | FolderRow
    | undefined
  if (!folder) return null

  return { folder, access }
}

/**
 * What a user may do with a file.
 *
 * A file at the top level (no folder) is reachable only by its owner. Anything
 * inside a folder inherits that folder's access.
 */
export function fileAccess(
  file: Pick<FileRow, 'owner_id' | 'folder_id'>,
  userId: string,
): Access | null {
  if (file.owner_id === userId) return 'owner'
  if (!file.folder_id) return null
  return folderAccess(file.folder_id, userId)
}

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

export interface Collaborator {
  userId: string
  username: string
  displayName: string | null
  hasAvatar: boolean
  avatarVersion: number | null
  role: CollaboratorRole
  createdAt: number
}

export function listCollaborators(folderId: string): Collaborator[] {
  return (
    db()
      .prepare(
        `SELECT c.user_id, c.role, c.created_at,
                u.username, u.display_name, u.avatar_path, u.avatar_updated_at
         FROM folder_collaborators c
         JOIN users u ON u.id = c.user_id
         WHERE c.folder_id = ?
         ORDER BY c.created_at`,
      )
      .all(folderId) as {
      user_id: string
      role: CollaboratorRole
      created_at: number
      username: string
      display_name: string | null
      avatar_path: string | null
      avatar_updated_at: number | null
    }[]
  ).map((r) => ({
    userId: r.user_id,
    username: r.username,
    displayName: r.display_name,
    hasAvatar: !!r.avatar_path,
    avatarVersion: r.avatar_updated_at,
    role: r.role,
    createdAt: r.created_at,
  }))
}

/** Cap per folder. A folder shared with fifty people is a mailing list. */
export const MAX_COLLABORATORS = 25

export function addCollaborator(opts: {
  folderId: string
  ownerId: string
  ownerName: string
  username: string
  role: CollaboratorRole
}): Collaborator {
  const folder = db()
    .prepare(`SELECT * FROM folders WHERE id = ? AND owner_id = ?`)
    .get(opts.folderId, opts.ownerId) as FolderRow | undefined

  // Owner-only, and only the top of a shared tree: inviting someone to a
  // subfolder of a folder they already have would be a second grant saying
  // the same thing, and revoking the outer one would silently leave it behind.
  if (!folder) throw new CollabError('Folder not found', 404)
  if (!folder.encrypted) {
    throw new CollabError('Only encrypted folders can have collaborators')
  }

  const target = db()
    .prepare(`SELECT id, username FROM users WHERE username = ? AND status = 'active'`)
    .get(opts.username.trim()) as { id: string; username: string } | undefined

  if (!target) throw new CollabError('No active account with that username', 404)
  if (target.id === opts.ownerId) throw new CollabError('You already own this folder')

  const count = db()
    .prepare(`SELECT COUNT(*) AS n FROM folder_collaborators WHERE folder_id = ?`)
    .get(opts.folderId) as { n: number }
  if (count.n >= MAX_COLLABORATORS) {
    throw new CollabError(`A folder can have at most ${MAX_COLLABORATORS} collaborators`, 409)
  }

  db()
    .prepare(
      `INSERT INTO folder_collaborators (folder_id, user_id, role, invited_by, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(folder_id, user_id) DO UPDATE SET role = excluded.role`,
    )
    .run(opts.folderId, target.id, opts.role, opts.ownerId, Date.now())

  audit({
    actorId: opts.ownerId,
    actorName: opts.ownerName,
    action: 'folder.collaborator_add',
    targetType: 'folder',
    targetId: opts.folderId,
    detail: { collaborator: target.username, role: opts.role },
  })

  return listCollaborators(opts.folderId).find((c) => c.userId === target.id)!
}

export function removeCollaborator(opts: {
  folderId: string
  ownerId: string
  ownerName: string
  userId: string
}): void {
  const folder = db()
    .prepare(`SELECT id FROM folders WHERE id = ? AND owner_id = ?`)
    .get(opts.folderId, opts.ownerId) as { id: string } | undefined
  if (!folder) throw new CollabError('Folder not found', 404)

  const target = db().prepare(`SELECT username FROM users WHERE id = ?`).get(opts.userId) as
    | { username: string }
    | undefined

  const res = db()
    .prepare(`DELETE FROM folder_collaborators WHERE folder_id = ? AND user_id = ?`)
    .run(opts.folderId, opts.userId)

  if (res.changes === 0) throw new CollabError('That person is not a collaborator', 404)

  audit({
    actorId: opts.ownerId,
    actorName: opts.ownerName,
    action: 'folder.collaborator_remove',
    targetType: 'folder',
    targetId: opts.folderId,
    detail: { collaborator: target?.username ?? opts.userId },
  })
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

export interface SharedFolder extends FolderRow {
  role: CollaboratorRole
  owner_name: string
  file_count: number
  total_bytes: number
}

/**
 * Folders other people have shared with this user.
 *
 * Only the granted folders themselves, not their subfolders — those appear by
 * navigating in, the same as for the owner.
 */
export function sharedWithMe(userId: string): SharedFolder[] {
  return db()
    .prepare(
      `SELECT f.*, c.role, u.username AS owner_name,
              (SELECT COUNT(*) FROM files x
                WHERE x.folder_id = f.id AND x.status = 'active' AND x.deleted_at IS NULL)
                AS file_count,
              (SELECT COALESCE(SUM(x.size_bytes), 0) FROM files x
                WHERE x.folder_id = f.id AND x.status = 'active' AND x.deleted_at IS NULL)
                AS total_bytes
       FROM folder_collaborators c
       JOIN folders f ON f.id = c.folder_id
       JOIN users u ON u.id = f.owner_id
       WHERE c.user_id = ?
       ORDER BY c.created_at DESC`,
    )
    .all(userId) as SharedFolder[]
}

/**
 * Subfolders of a folder the caller has access to, without the owner scoping
 * `listFolder` applies. Used when a collaborator navigates into a shared tree.
 */
export function listSharedChildren(
  folderId: string,
): (FolderRow & { file_count: number; total_bytes: number })[] {
  return db()
    .prepare(
      `SELECT f.*,
              (SELECT COUNT(*) FROM files x
                WHERE x.folder_id = f.id AND x.status = 'active' AND x.deleted_at IS NULL)
                AS file_count,
              (SELECT COALESCE(SUM(x.size_bytes), 0) FROM files x
                WHERE x.folder_id = f.id AND x.status = 'active' AND x.deleted_at IS NULL)
                AS total_bytes
       FROM folders f
       WHERE f.parent_id = ?
       ORDER BY f.name COLLATE NOCASE`,
    )
    .all(folderId) as (FolderRow & { file_count: number; total_bytes: number })[]
}

/**
 * Breadcrumbs for a folder, stopping at the highest ancestor the user can
 * reach.
 *
 * A collaborator invited to `/projects/keys` must not be shown that it sits
 * inside `/projects` — the trail stops where their access does.
 */
export function accessiblePath(folderId: string, userId: string): FolderRow[] {
  const chain: FolderRow[] = []
  const seen = new Set<string>()
  let cursor: string | null = folderId

  while (cursor && !seen.has(cursor) && chain.length <= MAX_DEPTH + 1) {
    seen.add(cursor)
    const row = db().prepare(`SELECT * FROM folders WHERE id = ?`).get(cursor) as
      | FolderRow
      | undefined
    if (!row) break
    if (!folderAccess(row.id, userId)) break

    chain.unshift(row)
    cursor = row.parent_id
  }
  return chain
}
