import fsp from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { PATHS } from './config'
import { db, type FileRow } from './db'
import { blobAbsPath } from './storage'
import { extractPoster, probeVideo } from './media'

/**
 * Preview generation and classification.
 *
 * Two separate jobs that belong together:
 *
 * - Deciding *what kind* of preview a file can have, which the file page and
 *   the embed metadata both need and must agree on.
 * - Producing a small image for the ones that can have a still, so neither a
 *   page view nor a Discord unfurl pulls the full original down.
 */

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type PreviewKind = 'image' | 'video' | 'audio' | 'none'

/**
 * Formats a browser will render inline.
 *
 * Deliberately narrower than "what the mime type claims": these are the ones
 * the download route also allows through as `inline`, and the two lists must
 * not drift apart or the page will offer a player for bytes the server will
 * only ever send as an attachment.
 */
const PREVIEWABLE: Record<string, PreviewKind> = {
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/gif': 'image',
  'image/webp': 'image',
  'image/avif': 'image',
  'image/bmp': 'image',
  'video/mp4': 'video',
  'video/webm': 'video',
  'audio/mpeg': 'audio',
  'audio/ogg': 'audio',
  'audio/wav': 'audio',
  'audio/mp4': 'audio',
}

/**
 * What kind of preview this file supports.
 *
 * Encrypted files always return 'none': the stored bytes are ciphertext, so
 * there is nothing for a player to decode and nothing the server could
 * thumbnail even if it wanted to. Their preview happens after decryption, in
 * the browser, which is a different path entirely.
 */
export function previewKind(file: Pick<FileRow, 'mime' | 'encrypted'>): PreviewKind {
  if (file.encrypted) return 'none'
  return PREVIEWABLE[(file.mime ?? '').toLowerCase()] ?? 'none'
}

/** Types sharp can decode into a still. GIF gives its first frame. */
const THUMBNAILABLE = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/tiff',
  'image/bmp',
])

/** Containers a poster frame can be pulled from, when ffmpeg is installed. */
const POSTERABLE = new Set(['video/mp4', 'video/webm', 'video/quicktime', 'video/x-m4v'])

export function canThumbnail(file: Pick<FileRow, 'mime' | 'encrypted'>): boolean {
  if (file.encrypted) return false
  return THUMBNAILABLE.has((file.mime ?? '').toLowerCase())
}

/**
 * Whether this file could have a still image generated for it.
 *
 * Wider than `canThumbnail`: it includes video, whose poster depends on ffmpeg
 * being present. Callers that need to know whether an image will *actually*
 * exist should ask `ensureThumb` for one rather than trusting this.
 */
export function canHaveStill(file: Pick<FileRow, 'mime' | 'encrypted'>): boolean {
  if (file.encrypted) return false
  const m = (file.mime ?? '').toLowerCase()
  return THUMBNAILABLE.has(m) || POSTERABLE.has(m)
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/** Long edge of a generated thumbnail. Comfortably above Discord's display size. */
export const THUMB_MAX_EDGE = 640

/**
 * Refuse to decode absurd images.
 *
 * A "decompression bomb" is a small file that expands to gigapixels — 64000 ×
 * 64000 is a few KB of PNG and tens of gigabytes of decoded pixels. sharp caps
 * this itself, but the cap is worth being explicit about since this runs on a
 * request path.
 */
const MAX_PIXELS = 100_000_000

function thumbAbsPath(relPath: string): string {
  const abs = path.resolve(PATHS.thumbs, relPath)
  if (abs !== PATHS.thumbs && !abs.startsWith(PATHS.thumbs + path.sep)) {
    throw new Error(`Refusing path outside thumb root: ${relPath}`)
  }
  return abs
}

export interface Thumb {
  absPath: string
  mime: string
}

/**
 * The thumbnail for a file, generating it on first request.
 *
 * Returns null when the file cannot have one, or when generation fails —
 * a corrupt or truncated image is a normal thing to be holding, and it must
 * degrade to "no preview" rather than to a 500.
 *
 * `thumb_state` records the outcome so a file that cannot be thumbnailed is
 * attempted once rather than on every single page view and unfurl.
 */
export async function ensureThumb(file: FileRow): Promise<Thumb | null> {
  if (!canHaveStill(file)) return null

  if (file.thumb_state === 'none') return null

  if (file.thumb_state === 'ready' && file.thumb_path) {
    const abs = thumbAbsPath(file.thumb_path)
    // The thumb directory is derived data and may have been cleared; fall
    // through to regeneration rather than serving a 404 for a file we hold.
    if (await fsp.stat(abs).then(() => true, () => false)) {
      return { absPath: abs, mime: 'image/webp' }
    }
  }

  // Mirrors the blob layout, so the two trees shard identically.
  const rel = path.join(file.id.slice(0, 2), file.id.slice(2, 4), `${file.id}.webp`)
  const abs = thumbAbsPath(rel)

  try {
    await fsp.mkdir(path.dirname(abs), { recursive: true, mode: 0o750 })

    // Video: pull a frame with ffmpeg. Absent ffmpeg this returns false and
    // the file is recorded as having no still, so it is not retried per view.
    if (previewKind(file) === 'video') {
      const ok = await extractPoster(
        blobAbsPath(file.storage_path),
        abs,
        file.media_duration,
        THUMB_MAX_EDGE,
      )
      if (!ok) {
        db().prepare(`UPDATE files SET thumb_state = 'none' WHERE id = ?`).run(file.id)
        return null
      }
      db()
        .prepare(`UPDATE files SET thumb_path = ?, thumb_state = 'ready' WHERE id = ?`)
        .run(rel, file.id)
      return { absPath: abs, mime: 'image/webp' }
    }

    await sharp(blobAbsPath(file.storage_path), {
      limitInputPixels: MAX_PIXELS,
      // Take the first frame of an animation. An animated thumbnail is a
      // surprising amount of bytes for a preview.
      animated: false,
    })
      .rotate() // honour EXIF orientation before resizing
      .resize(THUMB_MAX_EDGE, THUMB_MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
      // Re-encoding is what strips EXIF, including any GPS coordinates the
      // original carried. The thumbnail is safe to hand to a link unfurler in
      // a way the original is not.
      .webp({ quality: 78 })
      .toFile(abs)

    db()
      .prepare(`UPDATE files SET thumb_path = ?, thumb_state = 'ready' WHERE id = ?`)
      .run(rel, file.id)

    return { absPath: abs, mime: 'image/webp' }
  } catch (err) {
    console.warn('[preview] could not thumbnail', file.id, err)
    db().prepare(`UPDATE files SET thumb_state = 'none' WHERE id = ?`).run(file.id)
    await fsp.rm(abs, { force: true }).catch(() => {})
    return null
  }
}

/**
 * Video dimensions for a file, probing once and remembering the answer.
 *
 * These exist for the sake of link previews: without `og:video:width` and
 * `og:video:height` a chat client has no way to lay out a player and falls
 * back to showing a bare URL. Since that runs on an unauthenticated request
 * path it must be cheap, hence probing once and storing the result.
 *
 * `media_state = 'probed'` marks a file as looked at, so one that yields
 * nothing — a WebM on a server without ffmpeg — is not reopened on every
 * unfurl for an answer that will not change.
 */
export async function ensureMediaInfo(file: FileRow): Promise<{
  width: number | null
  height: number | null
  duration: number | null
}> {
  const known = {
    width: file.media_width,
    height: file.media_height,
    duration: file.media_duration,
  }

  if (file.media_state === 'probed') return known
  if (previewKind(file) !== 'video') return known

  const info = await probeVideo(blobAbsPath(file.storage_path), file.mime)

  db()
    .prepare(
      `UPDATE files SET media_width = ?, media_height = ?, media_duration = ?,
              media_state = 'probed' WHERE id = ?`,
    )
    .run(info?.width ?? null, info?.height ?? null, info?.duration ?? null, file.id)

  return {
    width: info?.width ?? null,
    height: info?.height ?? null,
    duration: info?.duration ?? null,
  }
}

/** Remove a file's thumbnail. Called when the file itself is deleted. */
export async function deleteThumb(file: Pick<FileRow, 'thumb_path'>): Promise<void> {
  if (!file.thumb_path) return
  await fsp.rm(thumbAbsPath(file.thumb_path), { force: true }).catch(() => {})
}
