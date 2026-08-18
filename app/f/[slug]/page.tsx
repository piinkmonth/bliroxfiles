import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { db, type FileRow, type FolderRow } from '@/lib/db'
import { currentUser } from '@/lib/auth'
import { fileAccess } from '@/lib/collab'
import { CDN_ORIGIN, PUBLIC_ORIGIN } from '@/lib/config'
import { bytesUrl } from '@/lib/share'
import { previewKind, canHaveStill, ensureThumb, ensureMediaInfo } from '@/lib/preview'
import { formatBytes, describeType } from '@/lib/format'
import { SplitLayout } from '@/components/SplitLayout'
import { DownloadCard } from './DownloadCard'
import { EncryptedCard } from './EncryptedCard'
import { LOGO_SRC } from '@/lib/branding'

export const dynamic = 'force-dynamic'

function loadFile(slug: string): FileRow | undefined {
  return db().prepare(`SELECT * FROM files WHERE slug = ?`).get(slug) as FileRow | undefined
}

/** True when the link is live, regardless of who is asking. */
function isServeable(file: FileRow | undefined): file is FileRow {
  if (!file || file.deleted_at || file.status !== 'active') return false
  if (file.expires_at && file.expires_at < Date.now()) return false
  if (file.burned_at || (file.burn_after !== null && file.burn_after <= 0)) return false
  return true
}

// ---------------------------------------------------------------------------
// Link previews
// ---------------------------------------------------------------------------

const SITE_NAME = 'Blirox'

/**
 * What a chat client shows when someone pastes one of these links.
 *
 * The hard rule here is that this runs for a request with *no session*: a
 * Discord unfurl, a Slack crawler, a preview bot. Anything conditioned on
 * being signed in must therefore be assumed absent, and anything the page
 * itself would withhold from a stranger has to be withheld here too — a
 * filename leaked through og:title is leaked just as thoroughly as one
 * rendered in the body.
 *
 * So the generic card is the default and detail is added only where the file
 * is genuinely open to anyone holding the link:
 *
 * - private          → generic, since even existence is owner-only
 * - password-locked  → generic, since the password gates the name too
 * - encrypted        → generic, since there is nothing readable to describe
 * - expired / gone   → generic, and deliberately identical to "never existed"
 */
export async function generateMetadata({
  params,
}: {
  params: { slug: string }
}): Promise<Metadata> {
  const file = loadFile(params.slug)

  const generic: Metadata = {
    title: `File from ${SITE_NAME}`,
    description: 'Shared through an invite-only file host.',
    robots: { index: false, follow: false },
    openGraph: {
      siteName: SITE_NAME,
      title: `File from ${SITE_NAME}`,
      description: 'Shared through an invite-only file host.',
      type: 'website',
    },
  }

  if (!isServeable(file)) return generic
  if (file.visibility === 'private' || file.password_hash || file.encrypted) return generic

  const kind = previewKind(file)
  const url = `${PUBLIC_ORIGIN}/f/${file.slug}`
  const bytes = `${CDN_ORIGIN}/api/dl/${file.slug}?inline=1`

  /*
   * The line under the title in a Discord embed.
   *
   * The uploader's own note wins when there is one — they know what the file
   * is and the generic line does not. Otherwise it leads with provenance,
   * because that is the question a link from an unfamiliar domain raises.
   */
  const description =
    file.note?.trim() ||
    [`File from ${SITE_NAME}`, formatBytes(file.size_bytes), describeType(file.mime, file.name)]
      .join(' · ')

  /*
   * A still image, when one can be made.
   *
   * Never the original: the thumbnail is bounded, re-encoded and EXIF-stripped,
   * so an unfurl costs tens of kilobytes off a home uplink instead of the full
   * file, and a photo's GPS coordinates are not handed to a chat server along
   * with it. For video this is a poster frame, which exists only where ffmpeg
   * does — hence asking for it rather than assuming.
   */
  const still = await ensureThumb(file)
  const stillUrl = still ? `${PUBLIC_ORIGIN}/api/thumb/${file.slug}` : null

  const common = { siteName: SITE_NAME, title: file.name, description, url }
  const base: Metadata = {
    title: `${file.name} · ${SITE_NAME}`,
    description,
    robots: { index: false, follow: false },
  }

  /*
   * Video.
   *
   * `og:type` has to be `video.other` — a chat client decides it is looking at
   * a video from the type, and leaving it as `website` gets the og:video tags
   * ignored entirely. Dimensions are equally load-bearing: without them there
   * is nothing to size the player frame with, and the embed degrades to a bare
   * link, which is exactly what it was doing.
   *
   * Notably absent: `twitter:card = player`. That card type requires a
   * `twitter:player` iframe URL, and declaring it without one produces an
   * invalid card that suppresses the embed rather than falling back to
   * something simpler. The og:video tags are what actually drive playback.
   */
  if (kind === 'video') {
    const info = await ensureMediaInfo(file)

    return {
      ...base,
      openGraph: {
        ...common,
        type: 'video.other',
        videos: [
          {
            url: bytes,
            secureUrl: bytes.startsWith('https:') ? bytes : undefined,
            type: file.mime ?? 'video/mp4',
            width: info.width ?? undefined,
            height: info.height ?? undefined,
          },
        ],
        images: stillUrl
          ? [
              {
                url: stillUrl,
                alt: file.name,
                width: info.width ?? undefined,
                height: info.height ?? undefined,
              },
            ]
          : undefined,
      },
      twitter: {
        card: stillUrl ? 'summary_large_image' : 'summary',
        title: file.name,
        description,
      },
    }
  }

  if (kind === 'audio') {
    return {
      ...base,
      openGraph: {
        ...common,
        type: 'music.song',
        audio: [{ url: bytes, type: file.mime ?? 'audio/mpeg' }],
        images: stillUrl ? [{ url: stillUrl, alt: file.name }] : undefined,
      },
    }
  }

  return {
    ...base,
    openGraph: {
      ...common,
      type: 'website',
      images: stillUrl ? [{ url: stillUrl, alt: file.name }] : undefined,
    },
    twitter: stillUrl
      ? { card: 'summary_large_image', title: file.name, description }
      : undefined,
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <SplitLayout>
      <div className="flex flex-1 flex-col justify-center px-10 py-10 xl:px-16">
        <h1 className="font-mono text-xl tracking-tight">{title}</h1>
        <p className="mt-3 max-w-sm text-sm leading-relaxed text-muted">{body}</p>
      </div>
    </SplitLayout>
  )
}

export default function FilePage({ params }: { params: { slug: string } }) {
  const file = loadFile(params.slug)

  if (!file) notFound()

  // Checked ahead of the removed/deleted test below, which it would otherwise
  // fall into and report as a broken link rather than a spent one.
  if (file.burned_at || (file.burn_after !== null && file.burn_after <= 0)) {
    return (
      <Notice
        title="This link has been used up"
        body="It was set to delete itself after a set number of downloads, and that number has been reached."
      />
    )
  }

  if (file.deleted_at || file.status === 'removed') notFound()

  if (file.status === 'quarantined') {
    return (
      <Notice
        title="This file has been removed"
        body="It was taken down after a report. If you think that was a mistake, contact whoever runs this server."
      />
    )
  }

  if (file.expires_at && file.expires_at < Date.now()) {
    return <Notice title="This link has expired" body="Ask whoever shared it for a new one." />
  }

  const viewer = currentUser()
  const access = viewer ? fileAccess(file, viewer.id) : null

  if (file.visibility === 'private' && !access) notFound()

  // ---- Encrypted files -----------------------------------------------------
  //
  // A different page entirely: there is nothing here to describe or preview,
  // because the server is holding ciphertext. Everything happens after the
  // visitor supplies the passphrase, in their browser.
  if (file.encrypted) {
    if (!file.enc_share && !access) notFound()

    const folder = file.folder_id
      ? (db().prepare(`SELECT * FROM folders WHERE id = ?`).get(file.folder_id) as
          | FolderRow
          | undefined)
      : undefined

    if (!folder?.kdf_salt || !folder.verifier) {
      return (
        <Notice
          title="This link is broken"
          body="This file's folder is missing its key material, so nothing can unlock it."
        />
      )
    }

    return (
      <SplitLayout reverse>
        <EncryptedCard
          fileId={file.id}
          slug={file.slug}
          sizeBytes={file.size_bytes}
          createdAt={file.created_at}
          logoSrc={LOGO_SRC}
          // Same-origin until a link is published, because until then the
          // fetch needs the session cookie and that cookie is host-only.
          downloadUrl={bytesUrl(file, CDN_ORIGIN)}
          folderCrypto={{
            kdfSalt: folder.kdf_salt,
            kdfParams: folder.kdf_params,
            verifier: folder.verifier,
          }}
        />
      </SplitLayout>
    )
  }

  // ---- Ordinary files ------------------------------------------------------
  const verifier = file.verified_by
    ? (db().prepare(`SELECT username FROM users WHERE id = ?`).get(file.verified_by) as
        | { username: string }
        | undefined)
    : undefined

  const owner = db()
    .prepare(
      `SELECT id, username, display_name, avatar_path, avatar_updated_at,
              account_verified_at, account_verified_note
       FROM users WHERE id = ?`,
    )
    .get(file.owner_id) as
    | {
        id: string
        username: string
        display_name: string | null
        avatar_path: string | null
        avatar_updated_at: number | null
        account_verified_at: number | null
        account_verified_note: string | null
      }
    | undefined

  return (
    <SplitLayout reverse>
      <DownloadCard
        slug={file.slug}
        name={file.name}
        sizeBytes={file.size_bytes}
        mime={file.mime}
        downloads={file.downloads}
        createdAt={file.created_at}
        // An anonymous file reveals nothing about who uploaded it — the id is
        // blanked too, since it would otherwise fetch their avatar.
        uploader={
          file.anonymous
            ? null
            : {
                id: owner?.id ?? '',
                username: owner?.username ?? 'unknown',
                displayName: owner?.display_name ?? null,
                hasAvatar: !!owner?.avatar_path,
                avatarVersion: owner?.avatar_updated_at ?? null,
                verified: !!owner?.account_verified_at,
                verifiedNote: owner?.account_verified_note ?? null,
              }
        }
        sha256={file.sha256}
        downloadUrl={bytesUrl(file, CDN_ORIGIN)}
        logoSrc={LOGO_SRC}
        country={file.country}
        verified={
          file.verified_at
            ? {
                at: file.verified_at,
                by: verifier?.username ?? 'staff',
                note: file.verified_note,
              }
            : null
        }
        previewKind={previewKind(file)}
        thumbUrl={canHaveStill(file) ? `/api/thumb/${file.slug}` : null}
        note={file.note}
        expiresAt={file.expires_at}
        burnAfter={file.burn_after}
        passwordProtected={!!file.password_hash}
      />
    </SplitLayout>
  )
}
