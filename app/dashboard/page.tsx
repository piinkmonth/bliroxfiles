import { redirect } from 'next/navigation'
import { currentUser, pendingNotices } from '@/lib/auth'
import { SecurityNotices } from '@/components/SecurityNotice'
import { db, type FileRow, type FolderRow } from '@/lib/db'
import { listFolder, allFolders, FolderError } from '@/lib/folders'
import {
  accessibleFolder,
  accessiblePath,
  listSharedChildren,
  listCollaborators,
  sharedWithMe,
  type Access,
} from '@/lib/collab'
import { CDN_ORIGIN } from '@/lib/config'
import { Nav } from '@/components/Nav'
import { LOGO_SRC } from '@/lib/branding'
import { Background } from '@/components/Background'
import { DashboardClient } from './DashboardClient'

export const dynamic = 'force-dynamic'

type FolderWithCounts = FolderRow & { file_count: number; total_bytes: number }

export default function DashboardPage({
  searchParams,
}: {
  searchParams: { folder?: string }
}) {
  const user = currentUser()
  if (!user) redirect('/login')

  const folderId = searchParams.folder || null

  /*
   * Two ways to be looking at a folder: you own it, or it was shared with you.
   *
   * They are resolved separately rather than through one query because the
   * owner path is scoped by owner_id everywhere — which is the right default
   * and worth keeping — while the shared path is scoped by an access check
   * that has to walk the folder tree.
   */
  let folder: FolderRow | null = null
  let access: Access = 'owner'
  let breadcrumbs: FolderRow[] = []
  let subfolders: FolderWithCounts[] = []

  if (folderId) {
    const found = accessibleFolder(folderId, user.id)
    // A stale ?folder= pointing at something since deleted, or at somebody
    // else's folder, drops the visitor back at the top level rather than 500ing
    // or confirming that the id exists.
    if (!found) redirect('/dashboard')

    folder = found.folder
    access = found.access

    if (access === 'owner') {
      try {
        const listing = listFolder(user.id, folderId)
        breadcrumbs = listing.breadcrumbs
        subfolders = listing.folders
      } catch (err) {
        if (err instanceof FolderError) redirect('/dashboard')
        throw err
      }
    } else {
      // The trail stops at the highest folder they were actually granted, so
      // being invited to a subfolder does not reveal what it sits inside.
      breadcrumbs = accessiblePath(folderId, user.id)
      subfolders = listSharedChildren(folderId)
    }
  } else {
    const listing = listFolder(user.id, null)
    breadcrumbs = listing.breadcrumbs
    subfolders = listing.folders
  }

  /*
   * Files inside a folder are scoped by the folder, not by owner: that is the
   * whole point of a collaborator being able to see them. At the top level
   * there is no folder to scope by, so it falls back to ownership.
   *
   * `IS ?` rather than `= ?` so a null binding matches top-level files;
   * `folder_id = NULL` is never true in SQL.
   */
  const files = folderId
    ? (db()
        .prepare(
          `SELECT * FROM files
           WHERE folder_id = ? AND status = 'active' AND deleted_at IS NULL
           ORDER BY created_at DESC LIMIT 500`,
        )
        .all(folderId) as FileRow[])
    : (db()
        .prepare(
          `SELECT * FROM files
           WHERE owner_id = ? AND status = 'active' AND deleted_at IS NULL
             AND folder_id IS NULL
           ORDER BY created_at DESC LIMIT 500`,
        )
        .all(user.id) as FileRow[])

  const isOwner = access === 'owner'

  return (
    <>
      <Background />
      <Nav
        logoSrc={LOGO_SRC}
        user={{
          id: user.id,
          username: user.username,
          role: user.role,
          usedBytes: user.used_bytes,
          quotaBytes: user.quota_bytes,
          hasAvatar: !!user.avatar_path,
          avatarVersion: user.avatar_updated_at,
        }}
      />
      {/* Rendered here rather than on the login form so it catches every way
          in — password, second factor, and Google alike. */}
      <SecurityNotices notices={pendingNotices(user.id)} />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <DashboardClient
          username={user.username}
          currentFolderId={folderId}
          folderName={folder?.name ?? null}
          access={access}
          cdnOrigin={CDN_ORIGIN}
          breadcrumbs={breadcrumbs.map((f) => ({
            id: f.id,
            name: f.name,
            encrypted: f.encrypted,
          }))}
          folders={subfolders.map((f) => ({
            id: f.id,
            name: f.name,
            encrypted: f.encrypted,
            file_count: f.file_count,
            total_bytes: f.total_bytes,
          }))}
          // Only your own folders are move destinations — a collaborator
          // rearranging somebody else's tree is not something sharing grants.
          moveTargets={allFolders(user.id)}
          inEncrypted={!!folder?.encrypted}
          folderCrypto={
            folder?.encrypted
              ? {
                  id: folder.id,
                  name: folder.name,
                  kdfSalt: folder.kdf_salt,
                  kdfParams: folder.kdf_params,
                  verifier: folder.verifier,
                }
              : null
          }
          // The roster is owner information: a collaborator sees the folder,
          // not who else was invited to it.
          collaborators={folder && isOwner && folder.encrypted ? listCollaborators(folder.id) : []}
          galleryToken={folder && isOwner ? folder.share_token : null}
          sharedWithMe={
            folderId
              ? []
              : sharedWithMe(user.id).map((f) => ({
                  id: f.id,
                  name: f.name,
                  encrypted: f.encrypted,
                  role: f.role,
                  ownerName: f.owner_name,
                  file_count: f.file_count,
                  total_bytes: f.total_bytes,
                }))
          }
          files={files.map((f) => ({
            id: f.id,
            slug: f.slug,
            name: f.name,
            sizeBytes: f.size_bytes,
            mime: f.mime,
            downloads: f.downloads,
            visibility: f.visibility,
            createdAt: f.created_at,
            encrypted: !!f.encrypted,
            encShare: !!f.enc_share,
            hasSharePassword: !!f.password_hash,
            anonymous: !!f.anonymous,
            mine: f.owner_id === user.id,
            note: f.note,
            expiresAt: f.expires_at,
            burnAfter: f.burn_after,
          }))}
        />
      </main>
    </>
  )
}
