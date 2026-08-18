'use client'

import { useState } from 'react'
import { Image as ImageIcon } from 'lucide-react'
import { formatBytes } from '@/lib/format'
import { MediaPlayer } from '@/components/MediaPlayer'
import type { PreviewKind } from '@/lib/preview'

/**
 * Inline preview for a shared file.
 *
 * What loads when, and why:
 *
 * - **Video and audio** render their player immediately with
 *   `preload="metadata"`. That fetches a few hundred kilobytes — enough for a
 *   duration and a scrub bar — and nothing more until someone presses play.
 *   Since the download route serves ranges, seeking then pulls only the part
 *   being seeked to.
 *
 * - **Images** show the generated thumbnail, which is small and already made.
 *   The original is behind a click, because for a 40 MB photo "preview" and
 *   "download" are the same number of bytes and the visitor should get to
 *   decide.
 *
 * Everything comes from the CDN hostname rather than this one. That host serves
 * user content under `default-src 'none'; sandbox` and only ever with a mime
 * type off the inline allowlist, so nothing rendered here can execute as the
 * app.
 */
export function FilePreview({
  kind,
  name,
  sizeBytes,
  inlineUrl,
  thumbUrl,
}: {
  kind: PreviewKind
  name: string
  sizeBytes: number
  inlineUrl: string
  thumbUrl: string | null
}) {
  const [full, setFull] = useState(false)
  const [failed, setFailed] = useState(false)

  if (kind === 'none' || failed) return null

  if (kind === 'video' || kind === 'audio') {
    return (
      <div className="mt-5 w-full max-w-lg">
        <MediaPlayer src={inlineUrl} kind={kind} poster={thumbUrl} title={name} />
        <p className="mt-1.5 font-mono text-[10px] text-muted">
          streams on demand · space to play, F for fullscreen
        </p>
      </div>
    )
  }

  // ---- Images --------------------------------------------------------------

  if (full) {
    return (
      <Frame>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={inlineUrl}
          alt={name}
          className="max-h-80 w-full object-contain"
          onError={() => setFailed(true)}
        />
        <button
          onClick={() => setFull(false)}
          className="mt-2 font-mono text-[11px] text-muted hover:text-text"
        >
          show thumbnail instead
        </button>
      </Frame>
    )
  }

  if (thumbUrl) {
    return (
      <Frame>
        <button
          onClick={() => setFull(true)}
          className="group relative block w-full"
          title={`Load the full ${formatBytes(sizeBytes)} image`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={thumbUrl}
            alt={name}
            className="max-h-80 w-full object-contain"
            onError={() => setFailed(true)}
          />
          <span className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition group-hover:bg-black/40 group-hover:opacity-100">
            <span className="inline-flex items-center gap-1.5 bg-bg px-2.5 py-1.5 font-mono text-[11px]">
              <ImageIcon size={12} />
              full size · {formatBytes(sizeBytes)}
            </span>
          </span>
        </button>
        <p className="mt-2 font-mono text-[10px] text-muted">preview · click for full size</p>
      </Frame>
    )
  }

  // No thumbnail was generated — offer the original behind a click, with the
  // cost stated, which is what the page did before thumbnails existed.
  return (
    <div className="mt-5 max-w-sm">
      <button onClick={() => setFull(true)} className="btn-ghost w-full text-xs">
        <ImageIcon size={13} />
        Show preview
      </button>
      <p className="mt-1.5 font-mono text-[10px] text-muted">
        loads the full {formatBytes(sizeBytes)} file
      </p>
    </div>
  )
}

function Frame({ children }: { children: React.ReactNode }) {
  return <div className="mt-5 max-w-sm border border-border bg-raised/40 p-2">{children}</div>
}
