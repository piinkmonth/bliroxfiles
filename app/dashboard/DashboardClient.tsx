'use client'

import { useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { Search, File as FileIcon, Users } from 'lucide-react'
import { Uploader } from '@/components/Uploader'
import { Folders, type FolderEntry, type Crumb } from './Folders'
import { FileTable } from './FileTable'
import { UnlockFolder } from './EncryptedFolderDialog'
import { Collaborators } from './Collaborators'
import { SharedWithMe, type SharedEntry } from './SharedWithMe'
import { ShareSettings } from './ShareSettings'
import { GalleryLink } from './GalleryLink'
import { cachedKey } from '@/lib/e2e'
import { useEffect } from 'react'
import { formatBytes } from '@/lib/format'
import type { Access, Collaborator } from '@/lib/collab'

export interface DashFile {
  id: string
  slug: string
  name: string
  sizeBytes: number
  mime: string | null
  downloads: number
  visibility: 'unlisted' | 'private'
  createdAt: number
  encrypted: boolean
  /** A passphrase-gated public link exists for this encrypted file. */
  encShare: boolean
  hasSharePassword: boolean
  anonymous: boolean
  /** False for a file in a folder somebody else shared with you. */
  mine: boolean
  note: string | null
  expiresAt: number | null
  /** Downloads left before the file self-destructs. */
  burnAfter: number | null
}

interface Props {
  username: string
  files: DashFile[]
  folders: FolderEntry[]
  breadcrumbs: Crumb[]
  currentFolderId: string | null
  folderName: string | null
  moveTargets: { id: string; name: string; depth: number }[]
  inEncrypted: boolean
  folderCrypto: { id: string; name: string; kdfSalt: string | null; kdfParams: string | null; verifier: string | null } | null
  /** What this user may do in the folder being viewed. */
  access: Access
  collaborators: Collaborator[]
  sharedWithMe: SharedEntry[]
  /** Gallery token for the folder being viewed, when one is published. */
  galleryToken: string | null
  /** Origin that serves file bytes, for building direct links. */
  cdnOrigin: string
}

export function DashboardClient({
  username,
  files,
  folders,
  breadcrumbs,
  currentFolderId,
  folderName,
  moveTargets,
  inEncrypted,
  folderCrypto,
  access,
  collaborators,
  sharedWithMe,
  galleryToken,
  cdnOrigin,
}: Props) {
  const router = useRouter()
  // Whether this tab currently holds the key for the folder being viewed.
  const [unlocked, setUnlocked] = useState(false)

  useEffect(() => {
    setUnlocked(!!(folderCrypto && cachedKey(folderCrypto.id)))
  }, [folderCrypto])
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [settingsFor, setSettingsFor] = useState<DashFile | null>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return files
    return files.filter((f) => f.name.toLowerCase().includes(q))
  }, [files, query])

  const totalBytes = useMemo(() => files.reduce((n, f) => n + f.sizeBytes, 0), [files])

  const isOwner = access === 'owner'
  // A viewer can read a shared folder but not put anything into it.
  const canUpload = access === 'owner' || access === 'contributor'

  async function remove(file: DashFile) {
    if (!confirm(`Delete "${file.name}"? The link will stop working immediately.`)) return
    setBusy(file.id)
    await fetch(`/api/files/${file.id}`, { method: 'DELETE' })
    setBusy(null)
    router.refresh()
  }

  async function moveFile(file: DashFile) {
    const options = [
      '0) top level',
      ...moveTargets.map((f, i) => `${i + 1}) ${'  '.repeat(f.depth)}${f.name}`),
    ].join('\n')
    const answer = prompt(`Move "${file.name}" to:\n\n${options}\n\nNumber:`)
    if (answer === null) return

    const index = Number(answer)
    if (!Number.isInteger(index) || index < 0 || index > moveTargets.length) {
      return alert('That is not one of the listed numbers.')
    }

    setBusy(file.id)
    const res = await fetch(`/api/files/${file.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId: index === 0 ? null : moveTargets[index - 1].id }),
    })
    const data = await res.json()
    setBusy(null)
    if (!data.ok) alert(data.error)
    router.refresh()
  }

  async function bulkDelete(ids: string[]) {
    if (!confirm(`Delete ${ids.length} file(s)? Their links stop working immediately.`)) return
    setBusy('bulk')
    // Sequential rather than parallel: these are cheap, and a burst of
    // simultaneous deletes would trip the mutation rate limit.
    for (const id of ids) {
      await fetch(`/api/files/${id}`, { method: 'DELETE' })
    }
    setBusy(null)
    router.refresh()
  }

  async function bulkMove(ids: string[]) {
    const options = [
      '0) top level',
      ...moveTargets.map((f, i) => `${i + 1}) ${'  '.repeat(f.depth)}${f.name}`),
    ].join('\n')
    const answer = prompt(`Move ${ids.length} file(s) to:\n\n${options}\n\nNumber:`)
    if (answer === null) return

    const index = Number(answer)
    if (!Number.isInteger(index) || index < 0 || index > moveTargets.length) {
      return alert('That is not one of the listed numbers.')
    }
    const folderId = index === 0 ? null : moveTargets[index - 1].id

    setBusy('bulk')
    for (const id of ids) {
      await fetch(`/api/files/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId }),
      })
    }
    setBusy(null)
    router.refresh()
  }

  async function bulkZip(ids: string[]) {
    // A form POST rather than fetch: the response is a stream the browser
    // should save directly, and buffering a multi-gigabyte archive into a Blob
    // just to trigger a download would defeat the streaming entirely.
    const form = document.createElement('form')
    form.method = 'POST'
    form.action = '/api/files/zip'
    form.style.display = 'none'
    const input = document.createElement('input')
    input.name = 'ids'
    input.value = JSON.stringify(ids)
    form.appendChild(input)
    document.body.appendChild(form)
    form.submit()
    setTimeout(() => form.remove(), 1000)
  }

  async function sharePassword(file: DashFile) {
    const next = prompt(
      file.hasSharePassword
        ? `Change the share password for "${file.name}". Leave blank to remove it.`
        : `Set a password on the link for "${file.name}".`,
      '',
    )
    if (next === null) return

    setBusy(file.id)
    const res = await fetch(`/api/files/${file.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sharePassword: next === '' ? null : next }),
    })
    const data = await res.json()
    setBusy(null)
    if (!data.ok) alert(data.error)
    router.refresh()
  }

  async function toggleAnonymous(file: DashFile) {
    setBusy(file.id)
    const res = await fetch(`/api/files/${file.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ anonymous: !file.anonymous }),
    })
    const data = await res.json()
    setBusy(null)
    if (!data.ok) alert(data.error)
    router.refresh()
  }

  /**
   * Publish or withdraw a passphrase-gated link for an encrypted file.
   *
   * The confirmation spells out what the link does and does not protect,
   * because this is the one action that turns end-to-end encrypted content
   * into something anybody on the internet can fetch. The ciphertext is
   * useless without the passphrase — but the filename is not encrypted, and
   * saying so before the link exists is better than explaining it afterwards.
   */
  async function toggleEncShare(file: DashFile) {
    if (!file.encShare) {
      const ok = confirm(
        `Share "${file.name}"?\n\n` +
          `Anyone with the link can fetch the encrypted bytes; only someone with the ` +
          `passphrase can read them. The filename is not encrypted.`,
      )
      if (!ok) return
    }

    setBusy(file.id)
    const res = await fetch(`/api/files/${file.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ encShare: !file.encShare }),
    })
    const data = await res.json()
    setBusy(null)
    if (!data.ok) alert(data.error)
    router.refresh()
  }

  async function toggleVisibility(file: DashFile) {
    setBusy(file.id)
    await fetch(`/api/files/${file.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        visibility: file.visibility === 'private' ? 'unlisted' : 'private',
      }),
    })
    setBusy(null)
    router.refresh()
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="display text-xl">{folderName ?? username}</h1>
        <p className="mt-1 flex flex-wrap items-center gap-x-1.5 font-mono text-xs text-muted">
          <span>
            {files.length} file{files.length === 1 ? '' : 's'} · {formatBytes(totalBytes)}
            {folders.length > 0 && ` · ${folders.length} folder${folders.length === 1 ? '' : 's'}`}
          </span>
          {!isOwner && (
            <span className="inline-flex items-center gap-1 text-accent">
              <Users size={11} />
              shared with you · {access === 'contributor' ? 'can add files' : 'view only'}
            </span>
          )}
        </p>
      </div>

      <Folders
        folders={folders}
        breadcrumbs={breadcrumbs}
        currentFolderId={currentFolderId}
        inEncrypted={inEncrypted}
        readOnly={!isOwner}
      />

      {!currentFolderId && <SharedWithMe folders={sharedWithMe} />}

      {/* A gallery publishes a whole folder as one page. Encrypted folders
          have nothing displayable, so they never get one. */}
      {isOwner && currentFolderId && !inEncrypted && (
        <GalleryLink folderId={currentFolderId} token={galleryToken} />
      )}

      {/* Only the owner sees who else is on a folder, and only encrypted
          folders can be shared at all. */}
      {isOwner && inEncrypted && currentFolderId && (
        <Collaborators folderId={currentFolderId} collaborators={collaborators} />
      )}

      {inEncrypted && folderCrypto && !unlocked ? (
        <UnlockFolder folder={folderCrypto} onUnlocked={() => setUnlocked(true)} />
      ) : (
        canUpload && (
          <Uploader
            folderId={currentFolderId}
            encrypted={inEncrypted}
            onComplete={() => router.refresh()}
          />
        )
      )}

      <section>
        <div className="mb-3 flex items-center justify-between gap-4">
          <h2 className="font-mono text-xs uppercase tracking-wide text-muted">files</h2>
          {files.length > 4 && (
            <div className="relative w-64">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
              <input
                className="input pl-9"
                placeholder="Search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          )}
        </div>

        {filtered.length === 0 ? (
          <div className="card flex flex-col items-center p-12 text-center">
            <FileIcon size={26} className="text-muted" />
            <p className="mt-3 font-mono text-xs text-muted">
              {files.length === 0 ? 'nothing here yet' : 'nothing matches that search'}
            </p>
          </div>
        ) : (
          <FileTable
            files={filtered}
            busyId={busy}
            folderId={currentFolderId}
            folderUnlocked={unlocked}
            cdnOrigin={cdnOrigin}
            onDelete={remove}
            onToggleVisibility={toggleVisibility}
            onMove={moveFile}
            onBulkDelete={bulkDelete}
            onBulkMove={bulkMove}
            onBulkZip={bulkZip}
            onSharePassword={sharePassword}
            onToggleAnonymous={toggleAnonymous}
            onToggleEncShare={toggleEncShare}
            onShareSettings={setSettingsFor}
          />
        )}
      </section>

      {settingsFor && (
        <ShareSettings
          file={settingsFor}
          onClose={() => setSettingsFor(null)}
          onSaved={() => router.refresh()}
        />
      )}
    </div>
  )
}

