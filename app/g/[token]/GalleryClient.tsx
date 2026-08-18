'use client'

import { useState } from 'react'
import Link from 'next/link'
import {
  Download, X, FileVideo, FileAudio, File as FileIcon, Image as ImageIcon,
} from 'lucide-react'
import { WordmarkClient } from '@/components/WordmarkClient'
import { ThemePicker } from '@/components/ThemePicker'
import { MediaPlayer } from '@/components/MediaPlayer'
import { formatBytes } from '@/lib/format'
import type { PreviewKind } from '@/lib/preview'

interface GalleryFile {
  slug: string
  name: string
  sizeBytes: number
  mime: string | null
  note: string | null
  kind: PreviewKind
  thumbUrl: string | null
  downloadUrl: string
}

/**
 * A folder published as one browsable page.
 *
 * Grid of thumbnails, with a lightbox for anything previewable. Nothing loads
 * at full size until it is opened: the grid shows only the generated stills,
 * so a folder of forty photos costs a megabyte to browse rather than the whole
 * folder.
 */
export function GalleryClient({
  name,
  ownerName,
  logoSrc,
  files,
}: {
  name: string
  ownerName: string
  logoSrc?: string | null
  files: GalleryFile[]
}) {
  const [open, setOpen] = useState<GalleryFile | null>(null)
  const totalBytes = files.reduce((n, f) => n + f.sizeBytes, 0)

  return (
    <div className="flex flex-1 flex-col px-10 py-10 xl:px-16">
      <header className="flex items-center">
        <Link href="/" aria-label="blirox files">
          <WordmarkClient src={logoSrc} />
        </Link>
        <div className="ml-auto">
          <ThemePicker compact />
        </div>
      </header>

      <main className="flex-1 py-12">
        <p className="font-mono text-xs text-muted">shared folder</p>
        <h1 className="mt-3 break-words text-2xl font-medium leading-snug">{name}</h1>
        <p className="mt-2 font-mono text-xs text-muted">
          {files.length} file{files.length === 1 ? '' : 's'} · {formatBytes(totalBytes)} · shared by{' '}
          {ownerName}
        </p>

        {files.length === 0 ? (
          <p className="mt-10 font-mono text-xs text-muted">
            nothing in here is publicly shared.
          </p>
        ) : (
          <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {files.map((file) => (
              <Tile key={file.slug} file={file} onOpen={() => setOpen(file)} />
            ))}
          </div>
        )}
      </main>

      <footer className="border-t border-border pt-5">
        <p className="font-mono text-[10px] text-muted">
          files shown here are the ones their owner made link-shareable. report abuse to whoever
          runs this server.
        </p>
      </footer>

      {open && <Lightbox file={open} onClose={() => setOpen(null)} />}
    </div>
  )
}

function iconFor(kind: PreviewKind) {
  if (kind === 'video') return FileVideo
  if (kind === 'audio') return FileAudio
  if (kind === 'image') return ImageIcon
  return FileIcon
}

function Tile({ file, onOpen }: { file: GalleryFile; onOpen: () => void }) {
  const [broken, setBroken] = useState(false)
  const Icon = iconFor(file.kind)
  const previewable = file.kind !== 'none'

  return (
    <div className="group relative">
      <button
        onClick={previewable ? onOpen : undefined}
        // A file with no preview is not a button that does nothing — it is a
        // download, and the cursor should say so.
        {...(previewable ? {} : { 'aria-disabled': true })}
        className={`block aspect-square w-full overflow-hidden border border-border bg-raised/40 ${
          previewable ? 'cursor-zoom-in' : 'cursor-default'
        }`}
        title={file.name}
      >
        {file.thumbUrl && !broken ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={file.thumbUrl}
            alt={file.name}
            loading="lazy"
            onError={() => setBroken(true)}
            className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
          />
        ) : (
          <span className="flex h-full w-full items-center justify-center">
            <Icon size={26} className="text-muted" />
          </span>
        )}
      </button>

      <div className="mt-1.5 flex items-start gap-1.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs" title={file.name}>
            {file.name}
          </p>
          <p className="font-mono text-[10px] text-muted">{formatBytes(file.sizeBytes)}</p>
        </div>
        <a
          href={file.downloadUrl}
          className="shrink-0 rounded p-1 text-muted hover:bg-raised hover:text-text"
          title={`Download ${file.name}`}
          aria-label={`Download ${file.name}`}
        >
          <Download size={13} />
        </a>
      </div>
    </div>
  )
}

function Lightbox({ file, onClose }: { file: GalleryFile; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/90 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={file.name}
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
      tabIndex={-1}
      // Autofocus so Escape works without clicking first. The media player
      // inside manages its own focus once interacted with.
      ref={(el) => el?.focus()}
    >
      <div className="flex items-center gap-3 text-white">
        <p className="min-w-0 flex-1 truncate text-sm">{file.name}</p>
        <a
          href={file.downloadUrl}
          className="inline-flex items-center gap-1.5 rounded px-2 py-1 font-mono text-[11px] opacity-80 hover:opacity-100"
        >
          <Download size={13} />
          download
        </a>
        <button onClick={onClose} className="rounded p-1 opacity-80 hover:opacity-100" aria-label="Close">
          <X size={18} />
        </button>
      </div>

      <div
        className="flex min-h-0 flex-1 items-center justify-center py-4"
        onClick={(e) => e.target === e.currentTarget && onClose()}
      >
        {file.kind === 'image' && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`${file.downloadUrl}?inline=1`}
            alt={file.name}
            className="max-h-full max-w-full object-contain"
          />
        )}

        {(file.kind === 'video' || file.kind === 'audio') && (
          <div className="w-full max-w-3xl">
            <MediaPlayer
              src={`${file.downloadUrl}?inline=1`}
              kind={file.kind}
              poster={file.thumbUrl}
              title={file.name}
            />
          </div>
        )}
      </div>

      {file.note && (
        <p className="mx-auto max-w-2xl whitespace-pre-wrap text-center text-xs text-white/70">
          {file.note}
        </p>
      )}
    </div>
  )
}
