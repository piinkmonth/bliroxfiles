'use client'

import { useState } from 'react'

/**
 * booty sex
 * self explanatory
 */
export default function LinkForm({ state, returnTo }: { state: string; returnTo: string }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [challenge, setChallenge] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function authorize(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)

    try {
      const res = await fetch('/api/auth/link-assert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          challenge
            ? { state, returnTo, challenge, code }
            : { state, returnTo, username, password },
        ),
      })
      const data = await res.json()

      if (!res.ok || !data.ok) {
        setError(data.error ?? 'Something went wrong')
        // A consumed challenge cannot be retried — drop back to the first step.
        if (res.status === 410) setChallenge(null)
        setBusy(false)
        return
      }

      if (data.requiresTwoFactor) {
        setChallenge(data.challenge)
        setCode('')
        setBusy(false)
        return
      }

      // Leaving this origin entirely — full navigation, not a router push.
      window.location.href = data.redirect
    } catch {
      setError('Network error — check your connection and try again')
      setBusy(false)
    }
  }

  function cancel() {
    /*
     * Deliberately does not bounce back to return_to. Cancelling mints no
     * assertion and lets blirox-id's flow expire, which is the right outcome;
     * sending the user onward with an error only invites a retry loop.
     */
    window.location.href = '/'
  }

  const field =
    'h-11 w-full rounded-card border border-border bg-bg px-3 text-sm text-text outline-none transition-colors placeholder:text-muted/60 focus:border-muted'

  return (
    <form onSubmit={authorize} className="flex flex-col gap-4">
      {challenge ? (
        <div className="flex flex-col gap-1.5">
          <label htmlFor="code" className="text-xs font-medium text-muted">
            Two-factor code
          </label>
          <input
            id="code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            placeholder="123456"
            className={`${field} font-mono tracking-[0.3em]`}
          />
          <p className="text-xs text-muted">Or use one of your backup codes.</p>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="username" className="text-xs font-medium text-muted">
              Blirox Files username
            </label>
            <input
              id="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              spellCheck={false}
              autoFocus
              className={field}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="password" className="text-xs font-medium text-muted">
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              className={field}
            />
          </div>
        </>
      )}

      {error && (
        <p className="rounded-card border border-danger/40 px-3 py-2 text-xs leading-relaxed text-danger">
          {error}
        </p>
      )}

      <div className="mt-2 flex gap-3">
        <button
          type="button"
          onClick={cancel}
          className="h-11 flex-1 rounded-card border border-border text-sm font-medium text-text transition-colors hover:bg-raised"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy}
          className="h-11 flex-[1.6] rounded-card bg-accent text-sm font-semibold text-accent-fg transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-40"
        >
          {busy ? 'Authorizing…' : 'Authorize'}
        </button>
      </div>
    </form>
  )
}
