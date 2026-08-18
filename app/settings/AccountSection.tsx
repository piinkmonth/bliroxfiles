'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Loader2, Link2Off, ShieldCheck } from 'lucide-react'
import { GoogleButton } from '@/components/GoogleButton'

export function AccountSection({
  googleEnabled,
  googleEmail,
  googleLinkedAt,
  hasPassword,
}: {
  googleEnabled: boolean
  googleEmail: string | null
  googleLinkedAt: number | null
  hasPassword: boolean
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')

  async function unlink() {
    if (!confirmUnlink()) return
    setBusy(true)
    setError(null)
    const res = await fetch('/api/auth/google/link', { method: 'DELETE' })
    const data = await res.json()
    setBusy(false)
    if (!data.ok) {
      setError(data.error)
      return
    }
    router.refresh()
  }

  function confirmUnlink() {
    return confirm_(
      hasPassword
        ? 'Disconnect Google from this account? You will sign in with your password instead.'
        : 'Disconnect Google?',
    )
  }

  // Wrapper so the `confirm` state variable does not shadow window.confirm.
  function confirm_(message: string) {
    return window.confirm(message)
  }

  async function savePassword(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (next !== confirm) {
      setError('The two new passwords do not match')
      return
    }

    setBusy(true)
    const res = await fetch('/api/profile/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        currentPassword: hasPassword ? current : undefined,
        newPassword: next,
      }),
    })
    const data = await res.json()
    setBusy(false)

    if (!data.ok) {
      setError(data.error)
      return
    }
    setCurrent('')
    setNext('')
    setConfirm('')
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
    router.refresh()
  }

  return (
    <>
      {/* Google ---------------------------------------------------------- */}
      {googleEnabled && (
        <section className="card p-6">
          <h2 className="font-medium">Google account</h2>

          {googleEmail ? (
            <>
              <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
                <ShieldCheck size={15} className="text-success" />
                Connected to <span className="text-text">{googleEmail}</span>
                {googleLinkedAt && (
                  <span className="font-mono text-xs">
                    since {new Date(googleLinkedAt).toLocaleDateString()}
                  </span>
                )}
              </p>
              <p className="mt-2 text-xs text-muted">
                This address is verified by Google, which is what makes it usable for account
                recovery.
              </p>
              <button onClick={unlink} className="btn-ghost mt-4 text-danger" disabled={busy}>
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Link2Off size={14} />}
                Disconnect
              </button>
            </>
          ) : (
            <>
              <p className="mt-1 text-sm text-muted">
                Connect Google to sign in without a password and get a verified email on your
                account.
              </p>
              <div className="mt-4 max-w-xs">
                <GoogleButton mode="link" label="Connect Google" />
              </div>
            </>
          )}

          {error && <p className="mt-3 border-l-2 border-danger pl-3 text-sm text-danger">{error}</p>}
        </section>
      )}

      {/* Password -------------------------------------------------------- */}
      <section className="card p-6">
        <h2 className="font-medium">{hasPassword ? 'Change password' : 'Set a password'}</h2>
        {!hasPassword && (
          <p className="mt-1 text-sm text-muted">
            This account signs in with Google only. Setting a password gives you a second way in —
            and is required before you can disconnect Google.
          </p>
        )}

        <form onSubmit={savePassword} className="mt-4 max-w-sm space-y-4">
          {hasPassword && (
            <div>
              <label className="label" htmlFor="current-pw">
                Current password
              </label>
              <input
                id="current-pw"
                type="password"
                className="input"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                autoComplete="current-password"
                required
              />
            </div>
          )}

          <div>
            <label className="label" htmlFor="new-pw">
              New password
            </label>
            <input
              id="new-pw"
              type="password"
              className="input"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              autoComplete="new-password"
              minLength={10}
              required
            />
          </div>

          <div>
            <label className="label" htmlFor="confirm-pw">
              Confirm new password
            </label>
            <input
              id="confirm-pw"
              type="password"
              className="input"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              minLength={10}
              required
            />
          </div>

          <p className="text-xs text-muted">
            Changing this signs out every other device.
          </p>

          {error && <p className="border-l-2 border-danger pl-3 text-sm text-danger">{error}</p>}

          <button type="submit" className="btn-primary" disabled={busy}>
            {busy && <Loader2 size={14} className="animate-spin" />}
            {saved && <Check size={14} />}
            {saved ? 'Saved' : hasPassword ? 'Change password' : 'Set password'}
          </button>
        </form>
      </section>
    </>
  )
}
