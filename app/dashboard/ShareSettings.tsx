'use client'

import { useState } from 'react'
import { X, Loader2, Clock, Flame, MessageSquare, QrCode } from 'lucide-react'
import type { DashFile } from './DashboardClient'

/**
 * Per-file share settings: how long the link lives, how many downloads it has
 * left, and what it says about itself.
 *
 * One dialog rather than three row actions because the three interact — a note
 * explaining what a file is matters most on exactly the links that are about to
 * expire, and seeing them together is how someone notices they have set a
 * seven-day expiry on something they meant to burn immediately.
 */

const EXPIRY_CHOICES: { label: string; ms: number | null }[] = [
  { label: 'Never', ms: null },
  { label: '1 hour', ms: 3600_000 },
  { label: '24 hours', ms: 86400_000 },
  { label: '7 days', ms: 7 * 86400_000 },
  { label: '30 days', ms: 30 * 86400_000 },
]

const BURN_CHOICES: { label: string; n: number | null }[] = [
  { label: 'Unlimited', n: null },
  { label: '1 download', n: 1 },
  { label: '5', n: 5 },
  { label: '25', n: 25 },
]

export function ShareSettings({
  file,
  onClose,
  onSaved,
}: {
  file: DashFile
  onClose: () => void
  onSaved: () => void
}) {
  const [note, setNote] = useState(file.note ?? '')
  const [expiryMs, setExpiryMs] = useState<number | null>(null)
  // null means "leave whatever is set alone"; a value means change it.
  const [expiryTouched, setExpiryTouched] = useState(false)
  const [burn, setBurn] = useState<number | null>(file.burnAfter)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showQr, setShowQr] = useState(false)

  async function save() {
    setBusy(true)
    setError(null)

    const body: Record<string, unknown> = { note: note.trim() || null }
    if (expiryTouched) {
      body.expiresAt = expiryMs === null ? null : Date.now() + expiryMs
    }
    if (burn !== file.burnAfter) body.burnAfter = burn

    const res = await fetch(`/api/files/${file.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()

    setBusy(false)
    if (!data.ok) {
      setError(data.error)
      return
    }
    onSaved()
    onClose()
  }

  const canBurn = !file.encrypted
  const shareable = file.encrypted ? file.encShare : file.visibility === 'unlisted'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="share-settings-title"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="card-solid max-h-[90vh] w-full max-w-md overflow-y-auto p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 id="share-settings-title" className="font-mono text-sm">
              share settings
            </h2>
            <p className="mt-1 truncate text-xs text-muted" title={file.name}>
              {file.name}
            </p>
          </div>
          <button onClick={onClose} className="shrink-0 text-muted hover:text-text" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        {/* Note ----------------------------------------------------------- */}
        <div className="mt-6">
          <label className="label" htmlFor="file-note">
            <span className="inline-flex items-center gap-1.5">
              <MessageSquare size={12} />
              Note
            </span>
          </label>
          <textarea
            id="file-note"
            className="input h-20 resize-none"
            placeholder="What is this? Shown on the share page and in link previews."
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
          />
          <p className="mt-1 text-right text-xs text-muted">{note.length}/500</p>
        </div>

        {/* Expiry --------------------------------------------------------- */}
        <div className="mt-5">
          <p className="label">
            <span className="inline-flex items-center gap-1.5">
              <Clock size={12} />
              Link expires
            </span>
          </p>
          <div className="flex flex-wrap gap-1.5">
            {EXPIRY_CHOICES.map((c) => (
              <Chip
                key={c.label}
                active={expiryTouched && expiryMs === c.ms}
                onClick={() => {
                  setExpiryTouched(true)
                  setExpiryMs(c.ms)
                }}
              >
                {c.label}
              </Chip>
            ))}
          </div>
          {file.expiresAt && !expiryTouched && (
            <p className="mt-2 font-mono text-[11px] text-warn">
              currently expires {new Date(file.expiresAt).toLocaleString()}
            </p>
          )}
        </div>

        {/* Burn after ----------------------------------------------------- */}
        <div className="mt-5">
          <p className="label">
            <span className="inline-flex items-center gap-1.5">
              <Flame size={12} />
              Delete after
            </span>
          </p>
          {canBurn ? (
            <>
              <div className="flex flex-wrap gap-1.5">
                {BURN_CHOICES.map((c) => (
                  <Chip key={c.label} active={burn === c.n} onClick={() => setBurn(c.n)}>
                    {c.label}
                  </Chip>
                ))}
              </div>
              {burn !== null && (
                <p className="mt-2 text-xs leading-relaxed text-warn">
                  The file is deleted from the server once that many downloads have finished. This
                  cannot be undone and the bytes are not recoverable.
                </p>
              )}
            </>
          ) : (
            <p className="text-xs leading-relaxed text-muted">
              Not available for encrypted files — the bytes are fetched again on every decrypt
              attempt, so a budget would be spent by a mistyped passphrase.
            </p>
          )}
        </div>

        {/* QR ------------------------------------------------------------- */}
        {shareable && (
          <div className="mt-5">
            <button
              onClick={() => setShowQr((v) => !v)}
              className="inline-flex items-center gap-1.5 font-mono text-[11px] text-muted hover:text-text"
            >
              <QrCode size={12} />
              {showQr ? 'hide qr code' : 'show qr code'}
            </button>
            {showQr && (
              <div className="mt-2 w-fit border border-border bg-white p-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/qr/${file.slug}`}
                  alt={`QR code linking to ${file.name}`}
                  className="h-36 w-36"
                />
              </div>
            )}
          </div>
        )}

        {error && (
          <p className="mt-4 border-l-2 border-danger pl-3 text-sm text-danger">{error}</p>
        )}

        <div className="mt-6 flex gap-2">
          <button onClick={save} disabled={busy} className="btn-primary flex-1 py-2.5">
            {busy && <Loader2 size={14} className="animate-spin" />}
            Save
          </button>
          <button onClick={onClose} className="btn-ghost">
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

function Chip({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`border px-2.5 py-1 font-mono text-[11px] transition-colors ${
        active
          ? 'border-accent bg-accent/10 text-accent'
          : 'border-border text-muted hover:border-muted hover:text-text'
      }`}
    >
      {children}
    </button>
  )
}
