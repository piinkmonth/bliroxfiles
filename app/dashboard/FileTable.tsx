'use client'

import { useState, useMemo } from 'react'
import {
  Copy, Trash2, Download, Eye, EyeOff, FolderInput, Lock, Check,
  FileText, FileImage, FileVideo, FileAudio, FileArchive, File as FileIcon,
  ArrowUpDown, KeyRound, UserRound, Link2, Share2, SlidersHorizontal, Flame, Clock,
} from 'lucide-react'
import { formatBytes, formatRelative } from '@/lib/format'
import type { DashFile } from './DashboardClient'
import { EncryptedDownload } from './EncryptedDownload'

type SortKey = 'name' | 'size' | 'date' | 'downloads'

/** Icon by broad file family — a video reads differently from a zip at a glance. */
function iconFor(mime: string | null, name: string) {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  const m = mime ?? ''

  if (m.startsWith('image/')) return FileImage
  if (m.startsWith('video/') || ['mkv', 'mp4', 'avi', 'mov', 'webm'].includes(ext)) return FileVideo
  if (m.startsWith('audio/') || ['mp3', 'flac', 'wav', 'ogg', 'm4a'].includes(ext)) return FileAudio
  if (
    m.includes('zip') || m.includes('compressed') || m.includes('tar') ||
    ['zip', 'rar', '7z', 'tar', 'gz', 'xz', 'iso'].includes(ext)
  ) {
    return FileArchive
  }
  if (m.startsWith('text/') || ['txt', 'md', 'log', 'json', 'csv'].includes(ext)) return FileText
  return FileIcon
}

export function FileTable({
  files,
  busyId,
  onDelete,
  onToggleVisibility,
  onMove,
  onSharePassword,
  onToggleAnonymous,
  onBulkDelete,
  onBulkMove,
  onBulkZip,
  onToggleEncShare,
  onShareSettings,
  folderId,
  folderUnlocked,
  cdnOrigin,
}: {
  files: DashFile[]
  busyId: string | null
  onDelete: (f: DashFile) => void
  onToggleVisibility: (f: DashFile) => void
  onMove: (f: DashFile) => void
  onSharePassword: (f: DashFile) => void
  onToggleAnonymous: (f: DashFile) => void
  onBulkDelete: (ids: string[]) => void
  onBulkMove: (ids: string[]) => void
  onBulkZip: (ids: string[]) => void
  onToggleEncShare: (f: DashFile) => void
  onShareSettings: (f: DashFile) => void
  folderId: string | null
  folderUnlocked: boolean
  cdnOrigin: string
}) {
  const [sort, setSort] = useState<SortKey>('date')
  const [asc, setAsc] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const sorted = useMemo(() => {
    const copy = [...files]
    copy.sort((a, b) => {
      let d = 0
      if (sort === 'name') d = a.name.localeCompare(b.name)
      else if (sort === 'size') d = a.sizeBytes - b.sizeBytes
      else if (sort === 'downloads') d = a.downloads - b.downloads
      else d = a.createdAt - b.createdAt
      return asc ? d : -d
    })
    return copy
  }, [files, sort, asc])

  function toggleSort(key: SortKey) {
    if (sort === key) setAsc((v) => !v)
    else {
      setSort(key)
      // Text reads best A–Z; numbers and dates read best largest/newest first.
      setAsc(key === 'name')
    }
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const allSelected = sorted.length > 0 && selected.size === sorted.length

  return (
    <div>
      {/* Bulk bar replaces the header row only when something is selected, so
          the default state stays uncluttered. */}
      {selected.size > 0 && (
        <div className="mb-2 flex items-center gap-3 border border-accent/40 bg-accent/5 px-3 py-2">
          <span className="font-mono text-xs text-accent">{selected.size} selected</span>
          <div className="ml-auto flex gap-2">
            {/* Zipping happens on the server, which cannot read encrypted
                files — an archive of ciphertext would be useless, so the
                option is not offered for a selection made entirely of them. */}
            {!sorted.filter((f) => selected.has(f.id)).every((f) => f.encrypted) && (
              <button
                className="btn-ghost text-xs"
                onClick={() => onBulkZip([...selected])}
                title="Download the selection as one ZIP"
              >
                <FileArchive size={13} />
                Download zip
              </button>
            )}
            <button
              className="btn-ghost text-xs"
              onClick={() => {
                onBulkMove([...selected])
                setSelected(new Set())
              }}
            >
              <FolderInput size={13} />
              Move
            </button>
            <button
              className="btn-ghost text-xs text-danger"
              onClick={() => {
                onBulkDelete([...selected])
                setSelected(new Set())
              }}
            >
              <Trash2 size={13} />
              Delete
            </button>
            <button className="btn-ghost text-xs" onClick={() => setSelected(new Set())}>
              Clear
            </button>
          </div>
        </div>
      )}

      <div className="card-solid overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border font-mono text-[11px] uppercase tracking-wide text-muted">
              <th className="w-8 py-2 pl-3">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={() =>
                    setSelected(allSelected ? new Set() : new Set(sorted.map((f) => f.id)))
                  }
                  className="accent-[rgb(var(--c-accent))]"
                  aria-label="Select all"
                />
              </th>
              <SortHeader label="name" active={sort === 'name'} asc={asc} onClick={() => toggleSort('name')} />
              <SortHeader label="size" active={sort === 'size'} asc={asc} onClick={() => toggleSort('size')} className="w-24 text-right" />
              <SortHeader label="dl" active={sort === 'downloads'} asc={asc} onClick={() => toggleSort('downloads')} className="w-16 text-right" />
              <SortHeader label="added" active={sort === 'date'} asc={asc} onClick={() => toggleSort('date')} className="w-32 text-right" />
              <th className="w-40 py-2 pr-3 text-right">actions</th>
            </tr>
          </thead>

          <tbody className="divide-y divide-border">
            {sorted.map((file) => {
              const Icon = iconFor(file.mime, file.name)
              const isBusy = busyId === file.id
              const isSelected = selected.has(file.id)

              return (
                <tr
                  key={file.id}
                  className={`group transition-colors ${
                    isSelected ? 'bg-accent/5' : 'hover:bg-raised/40'
                  } ${isBusy ? 'opacity-50' : ''}`}
                >
                  <td className="py-2.5 pl-3">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggle(file.id)}
                      className="accent-[rgb(var(--c-accent))]"
                      aria-label={`Select ${file.name}`}
                    />
                  </td>

                  <td className="min-w-0 py-2.5 pr-3">
                    <div className="flex items-center gap-2.5">
                      <Icon size={15} className="shrink-0 text-muted" />
                      <a
                        href={`/f/${file.slug}`}
                        className="truncate hover:text-accent"
                        title={file.name}
                      >
                        {file.name}
                      </a>
                      {file.encrypted && (
                        <Lock size={11} className="shrink-0 text-accent" aria-label="encrypted" />
                      )}
                      {file.visibility === 'private' && !file.encrypted && (
                        <EyeOff size={11} className="shrink-0 text-muted" aria-label="private" />
                      )}
                      {file.anonymous && (
                        <UserRound size={11} className="shrink-0 text-accent" aria-label="anonymous" />
                      )}
                      {file.burnAfter !== null && (
                        <span
                          className="inline-flex shrink-0 items-center gap-0.5 font-mono text-[10px] text-warn"
                          title={`Deleted after ${file.burnAfter} more download${file.burnAfter === 1 ? '' : 's'}`}
                        >
                          <Flame size={10} />
                          {file.burnAfter}
                        </span>
                      )}
                      {file.expiresAt && (
                        <Clock
                          size={11}
                          className="shrink-0 text-warn"
                          aria-label={`Expires ${new Date(file.expiresAt).toLocaleString()}`}
                        />
                      )}
                    </div>
                    {file.note && (
                      <p className="mt-0.5 truncate text-[11px] text-muted" title={file.note}>
                        {file.note}
                      </p>
                    )}
                  </td>

                  <td className="whitespace-nowrap py-2.5 text-right font-mono text-xs text-muted">
                    {formatBytes(file.sizeBytes)}
                  </td>
                  <td className="py-2.5 text-right font-mono text-xs text-muted">
                    {file.downloads}
                  </td>
                  <td className="whitespace-nowrap py-2.5 text-right font-mono text-xs text-muted">
                    {formatRelative(file.createdAt)}
                  </td>

                  <td className="py-2.5 pr-3">
                    {/* Revealed on hover on pointer devices, always visible on
                        touch where there is no hover state to rely on. */}
                    <div className="flex justify-end gap-0.5 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
                      {/* Everything that changes a file is the owner's alone.
                          A collaborator on a shared folder gets to read and
                          download, and nothing else. */}
                      {file.mine && (
                        <>
                          <RowAction
                            title="Note, expiry and download limit"
                            onClick={() => onShareSettings(file)}
                            disabled={isBusy}
                          >
                            <SlidersHorizontal
                              size={14}
                              className={
                                file.note || file.expiresAt || file.burnAfter !== null
                                  ? 'text-accent'
                                  : ''
                              }
                            />
                          </RowAction>
                          <RowAction
                            title="Move to folder"
                            onClick={() => onMove(file)}
                            disabled={isBusy}
                          >
                            <FolderInput size={14} />
                          </RowAction>

                          {file.encrypted ? (
                            <RowAction
                              title={
                                file.encShare
                                  ? 'Link published — click to withdraw it'
                                  : 'Publish a link anyone with the passphrase can open'
                              }
                              onClick={() => onToggleEncShare(file)}
                              disabled={isBusy}
                            >
                              <Share2 size={14} className={file.encShare ? 'text-accent' : ''} />
                            </RowAction>
                          ) : (
                            <>
                              <RowAction
                                title={
                                  file.hasSharePassword
                                    ? 'Change or remove the share password'
                                    : 'Add a password to the share link'
                                }
                                onClick={() => onSharePassword(file)}
                                disabled={isBusy}
                              >
                                <KeyRound
                                  size={14}
                                  className={file.hasSharePassword ? 'text-accent' : ''}
                                />
                              </RowAction>
                              <RowAction
                                title={
                                  file.anonymous
                                    ? 'Currently anonymous — click to show your name'
                                    : 'Share anonymously (hides your name and avatar)'
                                }
                                onClick={() => onToggleAnonymous(file)}
                                disabled={isBusy}
                              >
                                <UserRound
                                  size={14}
                                  className={file.anonymous ? 'text-accent' : ''}
                                />
                              </RowAction>
                            </>
                          )}
                        </>
                      )}

                      {/* Page link. For an encrypted file it only leads
                          anywhere once a link has actually been published. */}
                      <CopyAction
                        label="Copy share link"
                        value={`${typeof window === 'undefined' ? '' : window.location.origin}/f/${file.slug}`}
                        icon={<Copy size={14} />}
                        disabled={file.encrypted && !file.encShare}
                        disabledTitle="Publish a link for this encrypted file first"
                      />

                      {/* Direct link to the bytes, off the CDN hostname. */}
                      <CopyAction
                        label="Copy direct CDN link"
                        value={`${cdnOrigin}/api/dl/${file.slug}`}
                        icon={<Link2 size={14} />}
                        disabled={
                          (file.encrypted && !file.encShare) ||
                          (!file.encrypted && file.visibility === 'private')
                        }
                        disabledTitle={
                          file.encrypted
                            ? 'Publish a link for this encrypted file first'
                            : 'Private files have no direct link — make it link-shareable first'
                        }
                      />

                      {file.mine && !file.encrypted && (
                        <RowAction
                          title={
                            file.visibility === 'private' ? 'Make link-shareable' : 'Make private'
                          }
                          onClick={() => onToggleVisibility(file)}
                          disabled={isBusy}
                        >
                          {file.visibility === 'private' ? <EyeOff size={14} /> : <Eye size={14} />}
                        </RowAction>
                      )}

                      {file.encrypted ? (
                        folderUnlocked ? (
                          <EncryptedDownload
                            fileId={file.id}
                            slug={file.slug}
                            folderId={folderId}
                            name={file.name}
                          />
                        ) : (
                          <RowAction title="Unlock the folder to download" disabled>
                            <Download size={14} />
                          </RowAction>
                        )
                      ) : (
                        <RowAction title="Download" href={`/api/dl/${file.slug}`}>
                          <Download size={14} />
                        </RowAction>
                      )}

                      {file.mine && (
                        <RowAction
                          title="Delete"
                          onClick={() => onDelete(file)}
                          disabled={isBusy}
                          danger
                        >
                          <Trash2 size={14} />
                        </RowAction>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function SortHeader({
  label,
  active,
  asc,
  onClick,
  className = '',
}: {
  label: string
  active: boolean
  asc: boolean
  onClick: () => void
  className?: string
}) {
  return (
    <th className={`py-2 font-medium ${className}`}>
      <button
        onClick={onClick}
        className={`inline-flex items-center gap-1 hover:text-text ${active ? 'text-text' : ''}`}
      >
        {label}
        {active ? (
          <span className="text-accent">{asc ? '↑' : '↓'}</span>
        ) : (
          <ArrowUpDown size={10} className="opacity-40" />
        )}
      </button>
    </th>
  )
}

function RowAction({
  children,
  title,
  onClick,
  href,
  disabled,
  danger,
}: {
  children: React.ReactNode
  title: string
  onClick?: () => void
  href?: string
  disabled?: boolean
  danger?: boolean
}) {
  const cls = `rounded p-1.5 transition-colors disabled:opacity-25 ${
    danger ? 'text-muted hover:bg-danger/10 hover:text-danger' : 'text-muted hover:bg-raised hover:text-text'
  }`
  if (href && !disabled) {
    return (
      <a href={href} title={title} className={cls}>
        {children}
      </a>
    )
  }
  return (
    <button title={title} onClick={onClick} disabled={disabled} className={cls}>
      {children}
    </button>
  )
}

function CopyAction({
  label,
  value,
  icon,
  disabled,
  disabledTitle,
}: {
  label: string
  value: string
  icon: React.ReactNode
  disabled?: boolean
  disabledTitle?: string
}) {
  const [copied, setCopied] = useState(false)
  return (
    <RowAction
      title={disabled ? (disabledTitle ?? label) : label}
      disabled={disabled}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value)
        } catch {
          // Clipboard permission can be refused; say nothing rather than
          // showing a tick for something that did not happen.
          return
        }
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
    >
      {copied ? <Check size={14} className="text-success" /> : icon}
    </RowAction>
  )
}
