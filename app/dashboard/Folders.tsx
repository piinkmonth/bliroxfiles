'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Folder, FolderPlus, Lock, ChevronRight, Pencil, Trash2, Loader2 } from 'lucide-react'
import { CreateEncryptedFolder } from './EncryptedFolderDialog'
import { FolderName } from './FolderName'
import { formatBytes } from '@/lib/format'
import { cachedKey, decryptString, encryptString } from '@/lib/e2e'

export interface FolderEntry {
  id: string
  name: string
  encrypted: number
  file_count: number
  total_bytes: number
}

export interface Crumb {
  id: string
  name: string
  encrypted?: boolean | number
}

export function Folders({
  folders,
  breadcrumbs,
  currentFolderId,
  inEncrypted,
  readOnly = false,
}: {
  folders: FolderEntry[]
  breadcrumbs: Crumb[]
  currentFolderId: string | null
  inEncrypted: boolean
  /** Viewing a folder somebody else owns: no creating, renaming or deleting. */
  readOnly?: boolean
}) {
  const router = useRouter()
  const [creating, setCreating] = useState(false)
  const [creatingEncrypted, setCreatingEncrypted] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function create(e: React.FormEvent) {
    e.preventDefault()
    setBusy('create')
    setError(null)

    const res = await fetch('/api/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, parentId: currentFolderId }),
    })
    const data = await res.json()

    setBusy(null)
    if (!data.ok) {
      setError(data.error)
      return
    }
    setName('')
    setCreating(false)
    router.refresh()
  }

  async function rename(folder: FolderEntry) {
    const key = folder.encrypted ? cachedKey(folder.id) : undefined
    if (folder.encrypted && !key) {
      alert('Unlock this folder before renaming it.')
      return
    }

    const current = key ? ((await decryptString(folder.name, key)) ?? '') : folder.name
    const next = prompt('Rename folder', current)
    if (!next || next === current) return

    setBusy(folder.id)
    const res = await fetch(`/api/folders/${folder.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      // Encrypted folders store ciphertext, so encrypt before sending.
      body: JSON.stringify({ name: key ? await encryptString(next, key) : next }),
    })
    const data = await res.json()
    setBusy(null)
    if (!data.ok) alert(data.error)
    router.refresh()
  }

  async function remove(folder: FolderEntry) {
    const shown = folder.encrypted ? 'this encrypted folder' : `"${folder.name}"`
    const msg =
      folder.file_count > 0
        ? `Delete ${shown}?\n\nThe ${folder.file_count} file(s) inside are NOT deleted — they move up a level.`
        : `Delete ${shown}?`
    if (!confirm(msg)) return

    setBusy(folder.id)
    let res = await fetch(`/api/folders/${folder.id}`, { method: 'DELETE' })
    let data = await res.json()

    // Subfolders require explicit confirmation rather than silent recursion.
    if (!data.ok && res.status === 409) {
      if (confirm(`${shown} has subfolders. Delete those too?\n\nFiles still move up rather than being deleted.`)) {
        res = await fetch(`/api/folders/${folder.id}?recursive=1`, { method: 'DELETE' })
        data = await res.json()
      } else {
        setBusy(null)
        return
      }
    }

    setBusy(null)
    if (!data.ok) alert(data.error)
    router.refresh()
  }

  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <nav className="flex min-w-0 flex-1 items-center gap-1 font-mono text-xs text-muted">
          <Link href="/dashboard" className="hover:text-text">
            all files
          </Link>
          {breadcrumbs.map((c, i) => (
            <span key={c.id} className="flex min-w-0 items-center gap-1">
              <ChevronRight size={12} className="shrink-0 opacity-50" />
              {i === breadcrumbs.length - 1 ? (
                <span className="truncate text-text">
                  <FolderName id={c.id} name={c.name} encrypted={c.encrypted} />
                </span>
              ) : (
                <Link href={`/dashboard?folder=${c.id}`} className="truncate hover:text-text">
                  <FolderName id={c.id} name={c.name} encrypted={c.encrypted} />
                </Link>
              )}
            </span>
          ))}
        </nav>

        {!readOnly && (
          <>
            <button
              onClick={() => {
                setCreating((v) => !v)
                setCreatingEncrypted(false)
              }}
              className="btn-ghost shrink-0 text-xs"
            >
              <FolderPlus size={14} />
              New folder
            </button>

            {/* Encrypted folders can only be created at the top level: a child
                of an encrypted folder inherits its key, and a plain parent
                would leak the names of everything inside. */}
            {!inEncrypted && (
              <button
                onClick={() => {
                  setCreatingEncrypted((v) => !v)
                  setCreating(false)
                }}
                className="btn-ghost shrink-0 text-xs"
                title="Encrypted in your browser — contents unreadable by the server"
              >
                <Lock size={13} />
                Encrypted
              </button>
            )}
          </>
        )}
      </div>

      {creating && (
        <form onSubmit={create} className="mb-3 flex gap-2">
          <input
            className="input"
            placeholder="Folder name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            autoFocus
            required
          />
          <button type="submit" className="btn-primary shrink-0" disabled={busy === 'create'}>
            {busy === 'create' && <Loader2 size={14} className="animate-spin" />}
            Create
          </button>
        </form>
      )}

      {creatingEncrypted && (
        <div className="mb-3">
          <CreateEncryptedFolder
            parentId={currentFolderId}
            onDone={() => {
              setCreatingEncrypted(false)
              router.refresh()
            }}
            onCancel={() => setCreatingEncrypted(false)}
          />
        </div>
      )}

      {error && <p className="mb-3 border-l-2 border-danger pl-3 text-sm text-danger">{error}</p>}

      {folders.length > 0 && (
        <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {folders.map((folder) => (
            <div
              key={folder.id}
              className={`card flex items-center gap-3 p-3 transition-opacity ${
                busy === folder.id ? 'opacity-50' : ''
              }`}
            >
              <Link
                href={`/dashboard?folder=${folder.id}`}
                className="flex min-w-0 flex-1 items-center gap-2.5"
              >
                {folder.encrypted ? (
                  <Lock size={16} className="shrink-0 text-accent" />
                ) : (
                  <Folder size={16} className="shrink-0 text-muted" />
                )}
                <span className="min-w-0">
                  <span className="block truncate text-sm">
                    <FolderName id={folder.id} name={folder.name} encrypted={folder.encrypted} />
                  </span>
                  <span className="block font-mono text-[11px] text-muted">
                    {folder.file_count} file{folder.file_count === 1 ? '' : 's'}
                    {folder.total_bytes > 0 && ` · ${formatBytes(folder.total_bytes)}`}
                  </span>
                </span>
              </Link>

              {!readOnly && (
                <div className="flex shrink-0 items-center gap-0.5">
                  <button
                    onClick={() => rename(folder)}
                    className="rounded p-1.5 text-muted hover:bg-raised hover:text-text"
                    title="Rename"
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    onClick={() => remove(folder)}
                    className="rounded p-1.5 text-muted hover:bg-danger/10 hover:text-danger"
                    title="Delete"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
