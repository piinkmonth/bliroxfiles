'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ShieldCheck, Loader2, Copy, Check, KeyRound, AlertTriangle } from 'lucide-react'

type Stage = 'idle' | 'enrolling' | 'confirmed'

export function TwoFactorSection({
  enabled,
  enabledAt,
  backupCodesLeft,
  hasPassword,
}: {
  enabled: boolean
  enabledAt: number | null
  backupCodesLeft: number
  hasPassword: boolean
}) {
  const router = useRouter()
  const [stage, setStage] = useState<Stage>('idle')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [qr, setQr] = useState<string | null>(null)
  const [secret, setSecret] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [backupCodes, setBackupCodes] = useState<string[]>([])
  const [copied, setCopied] = useState(false)

  const [disablePassword, setDisablePassword] = useState('')
  const [disableCode, setDisableCode] = useState('')

  async function begin() {
    setBusy(true)
    setError(null)
    const res = await fetch('/api/profile/2fa', { method: 'POST' })
    const data = await res.json()
    setBusy(false)
    if (!data.ok) {
      setError(data.error)
      return
    }
    setQr(data.qr)
    setSecret(data.secret)
    setStage('enrolling')
  }

  async function confirm(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const res = await fetch('/api/profile/2fa', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    })
    const data = await res.json()
    setBusy(false)
    if (!data.ok) {
      setError(data.error)
      return
    }
    setBackupCodes(data.backupCodes)
    setStage('confirmed')
    router.refresh()
  }

  async function disable(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const res = await fetch('/api/profile/2fa', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: disablePassword, code: disableCode }),
    })
    const data = await res.json()
    setBusy(false)
    if (!data.ok) {
      setError(data.error)
      return
    }
    setDisablePassword('')
    setDisableCode('')
    router.refresh()
  }

  // --- backup codes, shown exactly once ------------------------------------
  if (stage === 'confirmed' && backupCodes.length > 0) {
    return (
      <section className="card border-warn/40 p-6">
        <h2 className="flex items-center gap-2 font-medium text-success">
          <ShieldCheck size={16} />
          Two-factor is on
        </h2>

        <div className="mt-4 border-l-2 border-warn pl-4">
          <p className="flex items-center gap-1.5 text-sm font-medium text-warn">
            <AlertTriangle size={14} />
            Save these backup codes now
          </p>
          <p className="mt-1.5 text-xs leading-relaxed text-muted">
            Each works once, and only these are shown — the server keeps hashes, so they cannot be
            recovered or displayed again. Without them, losing your phone means losing the account.
          </p>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2 font-mono text-sm sm:grid-cols-3">
          {backupCodes.map((c) => (
            <code key={c} className="rounded bg-raised px-2 py-1.5 text-center tracking-wider">
              {c}
            </code>
          ))}
        </div>

        <div className="mt-4 flex gap-2">
          <button
            className="btn-ghost"
            onClick={() => {
              navigator.clipboard.writeText(backupCodes.join('\n'))
              setCopied(true)
              setTimeout(() => setCopied(false), 1800)
            }}
          >
            {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
            {copied ? 'Copied' : 'Copy all'}
          </button>
          <button
            className="btn-primary"
            onClick={() => {
              setBackupCodes([])
              setStage('idle')
            }}
          >
            I&rsquo;ve saved them
          </button>
        </div>
      </section>
    )
  }

  // --- already on -----------------------------------------------------------
  if (enabled) {
    return (
      <section className="card p-6">
        <h2 className="flex items-center gap-2 font-medium">
          <ShieldCheck size={16} className="text-success" />
          Two-factor authentication
        </h2>
        <p className="mt-1 text-sm text-muted">
          On since {enabledAt ? new Date(enabledAt).toLocaleDateString() : 'recently'}.{' '}
          {backupCodesLeft} backup code{backupCodesLeft === 1 ? '' : 's'} left.
        </p>
        {backupCodesLeft <= 2 && (
          <p className="mt-2 border-l-2 border-warn pl-3 text-xs text-warn">
            Running low on backup codes. Turn two-factor off and on again to get a fresh set.
          </p>
        )}

        <details className="mt-4">
          <summary className="cursor-pointer text-sm text-muted hover:text-text">
            Turn it off
          </summary>
          <form onSubmit={disable} className="mt-3 max-w-sm space-y-3">
            {hasPassword && (
              <div>
                <label className="label" htmlFor="2fa-pw">
                  Password
                </label>
                <input
                  id="2fa-pw"
                  type="password"
                  className="input"
                  value={disablePassword}
                  onChange={(e) => setDisablePassword(e.target.value)}
                  autoComplete="current-password"
                  required
                />
              </div>
            )}
            <div>
              <label className="label" htmlFor="2fa-code-off">
                Current code
              </label>
              <input
                id="2fa-code-off"
                className="input font-mono tracking-widest"
                value={disableCode}
                onChange={(e) => setDisableCode(e.target.value)}
                inputMode="numeric"
                maxLength={6}
                placeholder="000000"
                required
              />
            </div>
            <p className="text-xs text-muted">
              Both are required — an unlocked session alone should not be able to strip a factor
              off the account. This also signs out every other device.
            </p>
            {error && <p className="border-l-2 border-danger pl-3 text-sm text-danger">{error}</p>}
            <button type="submit" className="btn-danger" disabled={busy}>
              {busy && <Loader2 size={14} className="animate-spin" />}
              Turn off two-factor
            </button>
          </form>
        </details>
      </section>
    )
  }

  // --- enrolling ------------------------------------------------------------
  return (
    <section className="card p-6">
      <h2 className="flex items-center gap-2 font-medium">
        <KeyRound size={16} />
        Two-factor authentication
      </h2>
      <p className="mt-1 text-sm text-muted">
        Adds a six-digit code from an authenticator app on top of your password. Works with Google
        Authenticator, Aegis, Ente Auth, 1Password, Bitwarden — anything that scans a QR code.
      </p>

      {stage === 'idle' ? (
        <>
          {error && <p className="mt-3 border-l-2 border-danger pl-3 text-sm text-danger">{error}</p>}
          <button onClick={begin} className="btn-primary mt-4" disabled={busy}>
            {busy && <Loader2 size={14} className="animate-spin" />}
            Set up two-factor
          </button>
        </>
      ) : (
        <div className="mt-5 flex flex-col gap-6 sm:flex-row">
          {qr && (
            <div className="shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={qr}
                alt="Two-factor QR code"
                width={200}
                height={200}
                className="rounded bg-white p-2"
              />
            </div>
          )}

          <div className="min-w-0 flex-1">
            <p className="text-sm text-muted">
              Scan this with your authenticator app, then enter the code it shows.
            </p>

            {secret && (
              <details className="mt-3">
                <summary className="cursor-pointer text-xs text-muted hover:text-text">
                  Can&rsquo;t scan? Enter this key by hand
                </summary>
                <code className="mt-2 block break-all rounded bg-raised px-3 py-2 font-mono text-xs">
                  {secret}
                </code>
              </details>
            )}

            <form onSubmit={confirm} className="mt-4 max-w-xs space-y-3">
              <div>
                <label className="label" htmlFor="2fa-code">
                  Code from your app
                </label>
                <input
                  id="2fa-code"
                  className="input text-center font-mono text-lg tracking-[0.4em]"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="000000"
                  autoComplete="one-time-code"
                  autoFocus
                  required
                />
              </div>

              {error && <p className="border-l-2 border-danger pl-3 text-sm text-danger">{error}</p>}

              <div className="flex gap-2">
                <button type="submit" className="btn-primary flex-1" disabled={busy || code.length < 6}>
                  {busy && <Loader2 size={14} className="animate-spin" />}
                  Confirm
                </button>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => {
                    setStage('idle')
                    setQr(null)
                    setCode('')
                    setError(null)
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  )
}
