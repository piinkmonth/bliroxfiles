'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Lock, Loader2, Download, KeyRound, ShieldCheck } from 'lucide-react'
import { WordmarkClient } from '@/components/WordmarkClient'
import { ThemePicker } from '@/components/ThemePicker'
import { formatBytes } from '@/lib/format'
import { unlockFolder, decryptBlob, type FileCrypto } from '@/lib/e2e'

/**
 * Public page for a file in an encrypted folder.
 *
 * Nothing about the file is shown before the passphrase is supplied — not its
 * name, not its type — because the server does not know them either in any
 * form it could vouch for. What it holds is ciphertext and the parameters
 * needed to derive a key from a passphrase it has never seen.
 *
 * The sequence: derive the key from the passphrase and the folder's salt,
 * check it against the folder verifier, fetch the ciphertext, decrypt it frame
 * by frame, and hand over the result as a Blob built entirely in this tab. The
 * plaintext never crosses the network and the passphrase never leaves the page.
 *
 * A wrong passphrase fails at the verifier, locally, with no request made —
 * which also means this page offers no way to test passphrases against the
 * server, because the server is not involved in the test.
 */
export function EncryptedCard({
  fileId,
  slug,
  sizeBytes,
  createdAt,
  logoSrc,
  downloadUrl,
  folderCrypto,
}: {
  fileId: string
  slug: string
  sizeBytes: number
  createdAt: number
  logoSrc?: string | null
  downloadUrl: string
  folderCrypto: { kdfSalt: string; kdfParams: string | null; verifier: string }
}) {
  const [passphrase, setPassphrase] = useState('')
  const [stage, setStage] = useState<'idle' | 'deriving' | 'fetching' | 'decrypting' | 'done'>(
    'idle',
  )
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ url: string; name: string } | null>(null)

  const busy = stage !== 'idle' && stage !== 'done'

  async function unlock(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setProgress(0)

    try {
      // Deriving is 600k PBKDF2 iterations and takes a visible moment on a
      // phone, so the stage is set before it starts rather than after.
      setStage('deriving')
      const key = await unlockFolder(passphrase, {
        kdf_salt: folderCrypto.kdfSalt,
        kdf_params: folderCrypto.kdfParams,
        verifier: folderCrypto.verifier,
      })

      if (!key) {
        setStage('idle')
        setError('That passphrase does not unlock this file.')
        return
      }

      setStage('fetching')
      const metaRes = await fetch(`/api/files/${fileId}/meta`)
      const metaJson = await metaRes.json()
      if (!metaJson.ok) throw new Error(metaJson.error || 'Could not read the file metadata')
      const meta = JSON.parse(metaJson.encMeta) as FileCrypto

      /*
       * `credentials: 'include'` because the bytes come from the CDN hostname
       * while this page is served from the app hostname. Cross-origin fetches
       * send no cookies by default, and without the session an owner checking
       * their own file before publishing a link for it would be told it does
       * not exist.
       */
      const res = await fetch(downloadUrl, { credentials: 'include' })
      if (!res.ok) {
        // The route sends CORS headers on its errors too, so the real reason
        // is readable here rather than being an opaque network failure.
        const detail = await res
          .json()
          .then((d: { error?: string }) => d.error)
          .catch(() => null)
        throw new Error(detail || `Could not fetch the file (${res.status})`)
      }
      const ciphertext = await res.blob()

      setStage('decrypting')
      const plain = await decryptBlob(ciphertext, key, meta, setProgress)

      setResult({
        url: URL.createObjectURL(plain),
        name: meta.originalName || slug,
      })
      setStage('done')
    } catch (err) {
      setStage('idle')
      setError(err instanceof Error ? err.message : 'Something went wrong')
    }
  }

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

      <main className="flex flex-1 flex-col justify-center py-16">
        <p className="flex items-center gap-1.5 font-mono text-xs text-accent">
          <Lock size={12} />
          encrypted file
        </p>

        <h1 className="mt-3 max-w-lg text-2xl font-medium leading-snug">
          {result ? result.name : 'Locked'}
        </h1>

        <p className="mt-3 max-w-sm text-sm leading-relaxed text-muted">
          This file was encrypted in someone&rsquo;s browser before it was uploaded. Whoever shared
          the link will have sent you the passphrase separately — this server has never had it and
          cannot recover it for you.
        </p>

        <dl className="mt-6 max-w-sm font-mono text-xs">
          <Row term="encrypted size" value={formatBytes(sizeBytes)} />
          <Row
            term="uploaded"
            value={new Date(createdAt).toLocaleString(undefined, {
              dateStyle: 'medium',
              timeStyle: 'short',
            })}
          />
        </dl>

        {result ? (
          <div className="mt-8 max-w-sm">
            <p className="flex items-center gap-1.5 text-sm text-success">
              <ShieldCheck size={15} />
              Decrypted in your browser
            </p>
            <a href={result.url} download={result.name} className="btn-primary mt-3 w-full py-2.5">
              <Download size={16} />
              Save {result.name}
            </a>
            <p className="mt-2 font-mono text-[10px] leading-relaxed text-muted">
              this file was assembled in this tab and never sent anywhere. closing the page discards
              it.
            </p>
          </div>
        ) : (
          <form onSubmit={unlock} className="mt-8 max-w-sm space-y-3">
            <div>
              <label className="label" htmlFor="enc-pass">
                <span className="inline-flex items-center gap-1.5">
                  <KeyRound size={12} />
                  Folder passphrase
                </span>
              </label>
              <input
                id="enc-pass"
                type="password"
                className="input"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                autoComplete="off"
                autoFocus
                required
                disabled={busy}
              />
            </div>

            {error && (
              <p className="border-l-2 border-danger pl-3 text-sm text-danger">{error}</p>
            )}

            <button type="submit" className="btn-primary w-full py-2.5" disabled={busy}>
              {busy && <Loader2 size={15} className="animate-spin" />}
              {stage === 'deriving'
                ? 'Deriving key…'
                : stage === 'fetching'
                  ? 'Fetching…'
                  : stage === 'decrypting'
                    ? `Decrypting ${Math.round(progress * 100)}%`
                    : 'Unlock'}
            </button>
          </form>
        )}
      </main>

      <footer className="max-w-sm border-t border-border pt-5">
        <p className="font-mono text-[10px] leading-relaxed text-muted">
          encrypted content cannot be scanned or moderated by this server. report abuse to whoever
          runs it, with the link.
        </p>
      </footer>
    </div>
  )
}

function Row({ term, value }: { term: string; value: string }) {
  return (
    <div className="flex items-baseline gap-3 py-1.5">
      <dt className="text-muted">{term}</dt>
      <span className="flex-1 translate-y-[-3px] border-b border-dotted border-border" />
      <dd className="truncate">{value}</dd>
    </div>
  )
}
