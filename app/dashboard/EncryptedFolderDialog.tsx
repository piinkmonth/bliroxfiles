'use client'

import { useState } from 'react'
import { Loader2, Lock, ShieldAlert } from 'lucide-react'
import { PasswordGenerator, generatePassphrase } from '@/components/PasswordGenerator'
import {
  createFolderCrypto,
  unlockFolder,
  cacheKey,
  encryptString,
  lockedFolderLabel,
} from '@/lib/e2e'

/** Create a new encrypted folder. */
export function CreateEncryptedFolder({
  parentId,
  onDone,
  onCancel,
}: {
  parentId: string | null
  onDone: () => void
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  const [passphrase, setPassphrase] = useState(() => generatePassphrase())
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (passphrase.length < 12) {
      setError('Use at least 12 characters — this cannot be reset if you lose it')
      return
    }

    setBusy(true)
    setError(null)

    try {
      // Key derivation is deliberately slow (600k PBKDF2 rounds); a second or
      // two here is the cost of making offline guessing expensive.
      const folderCrypto = await createFolderCrypto(passphrase)

      // Derive the key here so the name can be encrypted before it is sent —
      // the server must never see the plaintext folder name either.
      const key = await unlockFolder(passphrase, {
        kdf_salt: folderCrypto.kdfSalt,
        kdf_params: folderCrypto.kdfParams,
        verifier: folderCrypto.verifier,
      })
      if (!key) throw new Error('Key derivation failed')

      const res = await fetch('/api/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: await encryptString(name, key),
          parentId,
          encryption: folderCrypto,
        }),
      })
      const data = await res.json()
      if (!data.ok) {
        setError(data.error)
        return
      }

      // Cache it so the user isn't asked for the passphrase they just typed.
      cacheKey(data.folder.id, key)

      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the folder')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="card space-y-4 p-5">
      <h3 className="flex items-center gap-2 font-mono text-xs uppercase tracking-wide text-accent">
        <Lock size={13} />
        New encrypted folder
      </h3>

      <div>
        <label className="label" htmlFor="enc-name">
          Folder name
        </label>
        <input
          id="enc-name"
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          autoFocus
          required
        />
        <p className="mt-1.5 text-xs text-muted">
          Encrypted along with the contents. While the folder is locked it shows as
          &ldquo;Locked&rdquo; with a short id.
        </p>
      </div>

      <div>
        <label className="label">Passphrase</label>
        <PasswordGenerator value={passphrase} onChange={setPassphrase} />
      </div>

      <div className="border-l-2 border-warn pl-4 text-xs leading-relaxed text-muted">
        <p className="flex items-center gap-1.5 font-medium text-warn">
          <ShieldAlert size={13} />
          What encryption here does and does not do
        </p>
        <p className="mt-2">
          Files are encrypted in your browser before upload. The server stores bytes it cannot
          read, and neither can whoever runs this site.
        </p>
        <p className="mt-2">
          Because nobody can inspect the contents, encrypted files{' '}
          <strong className="text-text">can never be shared</strong> — no links, no public pages.
          Files are capped at 2 GB in encrypted folders.
        </p>
      </div>

      <label className="flex cursor-pointer items-start gap-2.5 text-sm">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          className="mt-1 accent-[rgb(var(--c-accent))]"
          required
        />
        <span className="text-muted">
          I&rsquo;ve saved this passphrase somewhere. I understand it cannot be recovered.
        </span>
      </label>

      {error && <p className="border-l-2 border-danger pl-3 text-sm text-danger">{error}</p>}

      <div className="flex gap-2">
        <button type="submit" className="btn-primary flex-1" disabled={busy || !confirmed}>
          {busy && <Loader2 size={14} className="animate-spin" />}
          {busy ? 'Deriving key…' : 'Create folder'}
        </button>
        <button type="button" onClick={onCancel} className="btn-ghost" disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  )
}

/** Prompt for a folder's passphrase and cache the derived key for this tab. */
export function UnlockFolder({
  folder,
  onUnlocked,
}: {
  folder: { id: string; name: string; kdfSalt: string | null; kdfParams: string | null; verifier: string | null }
  onUnlocked: () => void
}) {
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)

    const key = await unlockFolder(passphrase, {
      kdf_salt: folder.kdfSalt,
      kdf_params: folder.kdfParams,
      verifier: folder.verifier,
    })

    setBusy(false)
    if (!key) {
      setError('That passphrase is not right')
      return
    }

    cacheKey(folder.id, key)
    onUnlocked()
  }

  return (
    <form onSubmit={submit} className="card space-y-4 p-5">
      <h3 className="flex items-center gap-2 font-mono text-xs uppercase tracking-wide text-accent">
        <Lock size={13} />
        {lockedFolderLabel(folder.id)} is locked
      </h3>

      <div>
        <label className="label" htmlFor="unlock">
          Passphrase
        </label>
        <input
          id="unlock"
          type="password"
          className="input font-mono text-xs"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          autoComplete="off"
          autoFocus
          required
        />
      </div>

      {error && <p className="border-l-2 border-danger pl-3 text-sm text-danger">{error}</p>}

      <button type="submit" className="btn-primary w-full" disabled={busy}>
        {busy && <Loader2 size={14} className="animate-spin" />}
        {busy ? 'Deriving key…' : 'Unlock'}
      </button>

      <p className="font-mono text-[11px] text-muted">
        the key stays in this tab only — closing it re-locks the folder
      </p>
    </form>
  )
}
