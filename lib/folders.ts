import { db, type FolderRow } from './db'
import { newId } from './ids'

/** Nesting cap. Deep trees are almost always a mistake or an attack. */
export const MAX_DEPTH = 10
export const MAX_NAME_LENGTH = 80

export class FolderError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

/**
 * Names are shown in other people's browsers and in Content-Disposition, so
 * strip control characters and bidi overrides, and refuse path separators
 * outright — a folder called "../.." has no legitimate use.
 */
export function sanitiseFolderName(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\x00-\x1f\x7f‪-‮⁦-⁩]/g, '').trim()
  if (!cleaned) throw new FolderError('Folder needs a name')
  if (cleaned.length > MAX_NAME_LENGTH) {
    throw new FolderError(`Folder names are capped at ${MAX_NAME_LENGTH} characters`)
  }
  if (/[/\\]/.test(cleaned)) throw new FolderError('Folder names cannot contain slashes')
  if (cleaned === '.' || cleaned === '..') throw new FolderError('That name is reserved')
  return cleaned
}

/** Ciphertext names are opaque; only their size is our business. */
function boundedCiphertext(raw: string): string {
  const v = raw.trim()
  if (!v) throw new FolderError('Folder needs a name')
  // A 80-char name encrypts to well under this; anything larger is not a name.
  if (v.length > 1024) throw new FolderError('Encrypted folder name is too long')
  return v
}

export function getFolder(id: string, ownerId: string): FolderRow | null {
  const row = db()
    .prepare(`SELECT * FROM folders WHERE id = ? AND owner_id = ?`)
    .get(id, ownerId) as FolderRow | undefined
  return row ?? null
}

/** Root-to-folder path, for breadcrumbs. */
export function folderPath(id: string, ownerId: string): FolderRow[] {
  const chain: FolderRow[] = []
  const seen = new Set<string>()
  let cursor: string | null = id

  while (cursor && !seen.has(cursor) && chain.length <= MAX_DEPTH + 1) {
    seen.add(cursor)
    const row = getFolder(cursor, ownerId)
    if (!row) break
    chain.unshift(row)
    cursor = row.parent_id
  }
  return chain
}

export function folderDepth(id: string | null, ownerId: string): number {
  if (!id) return 0
  return folderPath(id, ownerId).length
}

/**
 * Every descendant of a folder, including itself.
 *
 * Used both for recursive delete and for the cycle check on move. Depth-capped
 * so a cycle introduced by a bad write cannot spin forever.
 */
export function descendantIds(id: string, ownerId: string): string[] {
  return (
    db()
      .prepare(
        `WITH RECURSIVE tree(id, depth) AS (
           SELECT id, 0 FROM folders WHERE id = ? AND owner_id = ?
           UNION ALL
           SELECT f.id, tree.depth + 1
           FROM folders f JOIN tree ON f.parent_id = tree.id
           WHERE tree.depth < ${MAX_DEPTH + 2}
         )
         SELECT id FROM tree`,
      )
      .all(id, ownerId) as { id: string }[]
  ).map((r) => r.id)
}

export interface CreateFolderOpts {
  ownerId: string
  name: string
  parentId?: string | null
  /** Marks the folder end-to-end encrypted. Contents become unshareable. */
  encryption?: { kdfSalt: string; kdfParams: string; verifier: string } | null
}

export function createFolder(opts: CreateFolderOpts): FolderRow {
  /*
   * An encrypted folder's name arrives already encrypted by the browser, so it
   * is opaque base64 rather than something to sanitise — there is nothing
   * human-readable to strip, and running it through the text rules would
   * corrupt the ciphertext. Length is still bounded.
   */
  const name = opts.encryption
    ? boundedCiphertext(opts.name)
    : sanitiseFolderName(opts.name)
  const parentId = opts.parentId || null

  let parent: FolderRow | null = null
  if (parentId) {
    parent = getFolder(parentId, opts.ownerId)
    if (!parent) throw new FolderError('Parent folder not found', 404)

    if (folderDepth(parentId, opts.ownerId) >= MAX_DEPTH) {
      throw new FolderError(`Folders can only nest ${MAX_DEPTH} deep`)
    }

    // An encrypted folder's children inherit its encryption; mixing a plain
    // subfolder inside one would leak filenames the user expects to be hidden.
    if (parent.encrypted && !opts.encryption) {
      throw new FolderError('Subfolders of an encrypted folder must also be encrypted')
    }
  }

  const id = newId()
  const enc = opts.encryption

  try {
    db()
      .prepare(
        `INSERT INTO folders
           (id, owner_id, parent_id, name, encrypted, kdf_salt, kdf_params, verifier, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        opts.ownerId,
        parentId,
        name,
        enc ? 1 : 0,
        enc?.kdfSalt ?? null,
        enc?.kdfParams ?? null,
        enc?.verifier ?? null,
        Date.now(),
      )
  } catch (err) {
    if (String(err).includes('UNIQUE')) {
      throw new FolderError(`You already have a folder called "${name}" here`, 409)
    }
    throw err
  }

  return getFolder(id, opts.ownerId)!
}

export function renameFolder(id: string, ownerId: string, rawName: string): void {
  const folder = getFolder(id, ownerId)
  if (!folder) throw new FolderError('Folder not found', 404)

  const name = folder.encrypted ? boundedCiphertext(rawName) : sanitiseFolderName(rawName)
  try {
    db().prepare(`UPDATE folders SET name = ? WHERE id = ? AND owner_id = ?`).run(name, id, ownerId)
  } catch (err) {
    if (String(err).includes('UNIQUE')) {
      throw new FolderError(`You already have a folder called "${name}" here`, 409)
    }
    throw err
  }
}

/**
 * Move a folder under a new parent.
 *
 * The cycle check is the important part: moving a folder into its own
 * descendant would detach that whole subtree from the root and make it
 * unreachable while still occupying quota.
 */
export function moveFolder(id: string, ownerId: string, newParentId: string | null): void {
  const folder = getFolder(id, ownerId)
  if (!folder) throw new FolderError('Folder not found', 404)

  if (newParentId) {
    if (newParentId === id) throw new FolderError('A folder cannot contain itself')

    const parent = getFolder(newParentId, ownerId)
    if (!parent) throw new FolderError('Destination folder not found', 404)

    if (descendantIds(id, ownerId).includes(newParentId)) {
      throw new FolderError('Cannot move a folder into one of its own subfolders')
    }

    if (Boolean(parent.encrypted) !== Boolean(folder.encrypted)) {
      throw new FolderError('Cannot move between encrypted and unencrypted folders')
    }

    // Depth of the moved subtree must still fit under the new parent.
    const subtreeDepth = maxDepthBelow(id, ownerId)
    if (folderDepth(newParentId, ownerId) + 1 + subtreeDepth > MAX_DEPTH) {
      throw new FolderError(`That would nest deeper than ${MAX_DEPTH} folders`)
    }
  }
  // Moving to the top level is always fine, including for encrypted folders —
  // that is where they are created in the first place. The rule that matters is
  // the one above: an encrypted folder must never end up inside a plain one.

  try {
    db()
      .prepare(`UPDATE folders SET parent_id = ? WHERE id = ? AND owner_id = ?`)
      .run(newParentId, id, ownerId)
  } catch (err) {
    if (String(err).includes('UNIQUE')) {
      throw new FolderError('A folder with that name already exists there', 409)
    }
    throw err
  }
}

function maxDepthBelow(id: string, ownerId: string): number {
  const row = db()
    .prepare(
      `WITH RECURSIVE tree(id, depth) AS (
         SELECT id, 0 FROM folders WHERE id = ? AND owner_id = ?
         UNION ALL
         SELECT f.id, tree.depth + 1
         FROM folders f JOIN tree ON f.parent_id = tree.id
         WHERE tree.depth < ${MAX_DEPTH + 2}
       )
       SELECT COALESCE(MAX(depth), 0) AS d FROM tree`,
    )
    .get(id, ownerId) as { d: number }
  return row.d
}

/**
 * Delete a folder.
 *
 * Contents are moved up to the parent rather than destroyed — deleting a
 * container should not silently take files with it. `recursive` deletes the
 * subtree's folders too, still lifting the files rather than removing them;
 * actual file deletion stays an explicit, separate action.
 */
export function deleteFolder(id: string, ownerId: string, recursive = false): void {
  const folder = getFolder(id, ownerId)
  if (!folder) throw new FolderError('Folder not found', 404)

  const children = db()
    .prepare(`SELECT COUNT(*) AS n FROM folders WHERE parent_id = ? AND owner_id = ?`)
    .get(id, ownerId) as { n: number }

  if (children.n > 0 && !recursive) {
    throw new FolderError('That folder has subfolders — delete them first, or confirm recursive', 409)
  }

  const ids = recursive ? descendantIds(id, ownerId) : [id]

  db().transaction(() => {
    const placeholders = ids.map(() => '?').join(',')
    db()
      .prepare(
        `UPDATE files SET folder_id = ? WHERE folder_id IN (${placeholders}) AND owner_id = ?`,
      )
      .run(folder.parent_id, ...ids, ownerId)

    // ON DELETE CASCADE clears the descendants once the root row goes.
    db().prepare(`DELETE FROM folders WHERE id = ? AND owner_id = ?`).run(id, ownerId)
  })()
}

export interface FolderListing {
  folder: FolderRow | null
  breadcrumbs: FolderRow[]
  folders: (FolderRow & { file_count: number; total_bytes: number })[]
}

export function listFolder(ownerId: string, folderId: string | null): FolderListing {
  const folder = folderId ? getFolder(folderId, ownerId) : null
  if (folderId && !folder) throw new FolderError('Folder not found', 404)

  const folders = db()
    .prepare(
      `SELECT f.*,
              (SELECT COUNT(*) FROM files x
                WHERE x.folder_id = f.id AND x.status = 'active' AND x.deleted_at IS NULL)
                AS file_count,
              (SELECT COALESCE(SUM(x.size_bytes), 0) FROM files x
                WHERE x.folder_id = f.id AND x.status = 'active' AND x.deleted_at IS NULL)
                AS total_bytes
       FROM folders f
       WHERE f.owner_id = ? AND f.parent_id IS ?
       ORDER BY f.name COLLATE NOCASE`,
    )
    .all(ownerId, folderId) as (FolderRow & { file_count: number; total_bytes: number })[]

  return {
    folder,
    breadcrumbs: folderId ? folderPath(folderId, ownerId) : [],
    folders,
  }
}

/** Flat list of every folder, for move-to pickers. */
export function allFolders(ownerId: string): { id: string; name: string; depth: number }[] {
  return db()
    .prepare(
      `WITH RECURSIVE tree(id, name, depth, sort) AS (
         SELECT id, name, 0, name FROM folders WHERE owner_id = ? AND parent_id IS NULL
         UNION ALL
         SELECT f.id, f.name, tree.depth + 1, tree.sort || '/' || f.name
         FROM folders f JOIN tree ON f.parent_id = tree.id
         WHERE tree.depth < ${MAX_DEPTH}
       )
       SELECT id, name, depth FROM tree ORDER BY sort COLLATE NOCASE`,
    )
    .all(ownerId) as { id: string; name: string; depth: number }[]
}
