import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { db, type FileRow, type FolderRow } from '@/lib/db'
import { CDN_ORIGIN, PUBLIC_ORIGIN } from '@/lib/config'
import { bytesUrl } from '@/lib/share'
import { previewKind, canHaveStill } from '@/lib/preview'
import { formatBytes } from '@/lib/format'
import { SplitLayout } from '@/components/SplitLayout'
import { LOGO_SRC } from '@/lib/branding'
import { GalleryClient } from './GalleryClient'

export const dynamic = 'force-dynamic'

const SITE_NAME = 'Blirox'

interface Gallery {
  folder: FolderRow
  owner: { username: string; displayName: string | null } | undefined
  files: FileRow[]
}

/**
 * Everything a gallery token resolves to, or null.
 *
 * The file filter is the important part. A gallery publishes the *folder*, but
 * each file still carries its own settings, and the folder being public is not
 * a reason to override them:
 *
 * - `visibility = 'unlisted'` only. A file explicitly marked private stays
 *   private even when it sits in a published folder.
 * - No password-protected files, whose password exists to gate exactly this.
 * - No encrypted files, which have nothing displayable.
 * - No expired or spent files, matching what the download route would serve.
 *
 * Uploads default to unlisted, so in practice a gallery shows what its owner
 * expects — while anything they deliberately locked down stays that way.
 */
function loadGallery(token: string): Gallery | null {
  const folder = db().prepare(`SELECT * FROM folders WHERE share_token = ?`).get(token) as
    | FolderRow
    | undefined

  if (!folder || folder.encrypted) return null

  const owner = db()
    .prepare(`SELECT username, display_name FROM users WHERE id = ?`)
    .get(folder.owner_id) as { username: string; display_name: string | null } | undefined

  const files = db()
    .prepare(
      `SELECT * FROM files
        WHERE folder_id = ?
          AND status = 'active' AND deleted_at IS NULL
          AND visibility = 'unlisted'
          AND password_hash IS NULL
          AND encrypted = 0
          AND (expires_at IS NULL OR expires_at > ?)
          AND (burn_after IS NULL OR burn_after > 0)
        ORDER BY created_at DESC
        LIMIT 500`,
    )
    .all(folder.id, Date.now()) as FileRow[]

  return {
    folder,
    owner: owner ? { username: owner.username, displayName: owner.display_name } : undefined,
    files,
  }
}

export async function generateMetadata({
  params,
}: {
  params: { token: string }
}): Promise<Metadata> {
  const gallery = loadGallery(params.token)

  if (!gallery) {
    return {
      title: `Gallery from ${SITE_NAME}`,
      robots: { index: false, follow: false },
    }
  }

  const totalBytes = gallery.files.reduce((n, f) => n + f.size_bytes, 0)
  const description = `${gallery.files.length} file${
    gallery.files.length === 1 ? '' : 's'
  } · ${formatBytes(totalBytes)} · shared from ${SITE_NAME}`

  // The newest file that can supply a still becomes the cover image.
  const cover = gallery.files.find((f) => canHaveStill(f))

  return {
    title: `${gallery.folder.name} · ${SITE_NAME}`,
    description,
    robots: { index: false, follow: false },
    openGraph: {
      siteName: SITE_NAME,
      title: gallery.folder.name,
      description,
      url: `${PUBLIC_ORIGIN}/g/${params.token}`,
      type: 'website',
      images: cover ? [{ url: `${PUBLIC_ORIGIN}/api/thumb/${cover.slug}` }] : undefined,
    },
    twitter: cover
      ? { card: 'summary_large_image', title: gallery.folder.name, description }
      : undefined,
  }
}

export default function GalleryPage({ params }: { params: { token: string } }) {
  const gallery = loadGallery(params.token)
  if (!gallery) notFound()

  return (
    <SplitLayout reverse>
      <GalleryClient
        name={gallery.folder.name}
        ownerName={gallery.owner?.displayName || gallery.owner?.username || 'unknown'}
        logoSrc={LOGO_SRC}
        files={gallery.files.map((f) => ({
          slug: f.slug,
          name: f.name,
          sizeBytes: f.size_bytes,
          mime: f.mime,
          note: f.note,
          kind: previewKind(f),
          thumbUrl: canHaveStill(f) ? `/api/thumb/${f.slug}` : null,
          // A gallery only ever lists publicly fetchable files, so this always
          // resolves to the CDN — routed through the same rule so it stays
          // true if that filter is ever loosened.
          downloadUrl: bytesUrl(f, CDN_ORIGIN),
        }))}
      />
    </SplitLayout>
  )
}
