'use client'

import { useState } from 'react'
import { Download, Loader2, Lock } from 'lucide-react'
import { decryptBlob, cachedKey, type FileCrypto } from '@/lib/e2e'

/**
 * Fetch an encrypted file, decrypt it in the browser, and hand it to the user
 * as a normal download.
 *
 * The plaintext never touches the network and never reaches the server — the
 * object URL is created from a Blob built entirely in this tab, and revoked as
 * soon as the download is triggered.
 */
export function EncryptedDownload({
  fileId,
  slug,
  folderId,
  name,
}: {
  fileId: string
  slug: string
  folderId: string | null
  name: string
}) {
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState<'idle' | 'downloading' | 'decrypting'>('idle')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)

  async function run() {
    const key = folderId ? cachedKey(folderId) : undefined
    if (!key) {
      setError('Unlock the folder first')
      return
    }

    setBusy(true)
    setError(null)

    try {
      // The encryption metadata lives on the file row, not in the blob, so it
      // has to be fetched separately before anything can be decrypted.
      setStage('downloading')
      const metaRes = await fetch(`/api/files/${fileId}/meta`)
      const metaJson = await metaRes.json()
      if (!metaJson.ok) throw new Error(metaJson.error || 'Could not read file metadata')

      const meta = JSON.parse(metaJson.encMeta) as FileCrypto

      const res = await fetch(`/api/dl/${slug}`)
      if (!res.ok) throw new Error(`Download failed (${res.status})`)
      const ciphertext = await res.blob()

      setStage('decrypting')
      const plain = await decryptBlob(ciphertext, key, meta, (f) => setProgress(f))

      const url = URL.createObjectURL(plain)
      const a = document.createElement('a')
      a.href = url
      a.download = meta.originalName || name
      document.body.appendChild(a)
      a.click()
      a.remove()
      // Revoke on the next tick — revoking synchronously can cancel the
      // download in some browsers before it has started reading the blob.
      setTimeout(() => URL.revokeObjectURL(url), 30_000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Decryption failed')
    } finally {
      setBusy(false)
      setStage('idle')
      setProgress(0)
    }
  }

  return (
    <div>
      <button
        onClick={run}
        disabled={busy}
        className="rounded p-1.5 text-muted transition-colors hover:bg-raised hover:text-text disabled:opacity-40"
        title="Decrypt and download"
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
      </button>

      {busy && (
        <span className="ml-1 font-mono text-[10px] text-muted">
          {stage === 'downloading' ? 'fetching' : `decrypting ${Math.round(progress * 100)}%`}
        </span>
      )}

      {error && (
        <span className="ml-1 inline-flex items-center gap-1 font-mono text-[10px] text-danger">
          <Lock size={10} />
          {error}
        </span>
      )}
    </div>
  )
}
