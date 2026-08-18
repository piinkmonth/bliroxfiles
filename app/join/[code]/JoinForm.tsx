'use client'

import { useState } from 'react'
import { WordmarkClient } from '@/components/WordmarkClient'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Loader2 } from 'lucide-react'
import { ThemePicker } from '@/components/ThemePicker'
import { GoogleButton, AuthDivider } from '@/components/GoogleButton'
import { Terms } from '@/components/Terms'

export function JoinForm({
  code,
  quotaLabel,
  logoSrc,
  googleEnabled = false,
}: {
  code: string
  quotaLabel: string
  logoSrc?: string | null
  googleEnabled?: boolean
}) {
  const router = useRouter()
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [accepted, setAccepted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)

    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, username, email: email || undefined, password }),
      })
      const data = await res.json()
      if (!data.ok) {
        setError(data.error)
        return
      }
      router.push('/dashboard')
      router.refresh()
    } catch {
      setError('Could not reach the server')
    } finally {
      setBusy(false)
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

      <main className="flex flex-1 flex-col justify-center py-12">
        <h1 className="font-mono text-xl tracking-tight">You&rsquo;ve been invited</h1>
        <p className="mt-2 font-mono text-xs text-muted">
          {quotaLabel} of storage · account is yours to keep
        </p>

        <form onSubmit={submit} className="mt-8 max-w-lg space-y-5">
          <div>
            <label className="label" htmlFor="username">
              Username
            </label>
            <input
              id="username"
              className="input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              minLength={3}
              maxLength={24}
              pattern="[a-zA-Z0-9_\-]+"
              autoFocus
              required
            />
          </div>

          <div>
            <label className="label" htmlFor="email">
              Email <span className="normal-case text-muted">— optional</span>
            </label>
            <input
              id="email"
              type="email"
              className="input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
            />
            <p className="mt-1.5 text-xs text-muted">
              The only way back in if you forget your password.
            </p>
          </div>

          <div>
            <label className="label" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              type="password"
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              minLength={10}
              required
            />
            <p className="mt-1.5 text-xs text-muted">10 characters minimum. A phrase is fine.</p>
          </div>

          <div>
            <h2 className="font-mono text-xs uppercase tracking-wide text-muted">
              Terms — read before continuing
            </h2>
            <div className="mt-3">
              <Terms scroll />
            </div>
            <p className="mt-2 font-mono text-[11px] text-muted">
              Also at{' '}
              <Link href="/terms" target="_blank" className="text-accent hover:underline">
                /terms
              </Link>
              .
            </p>
          </div>

          <label className="flex cursor-pointer items-start gap-2.5 text-sm">
            <input
              type="checkbox"
              checked={accepted}
              onChange={(e) => setAccepted(e.target.checked)}
              className="mt-1 accent-[rgb(var(--c-accent))]"
              required
            />
            <span className="text-muted">
              I&rsquo;ve read the terms above and agree to them.
            </span>
          </label>

          {error && <p className="border-l-2 border-danger pl-3 text-sm text-danger">{error}</p>}

          <button type="submit" className="btn-primary w-full" disabled={busy || !accepted}>
            {busy && <Loader2 size={15} className="animate-spin" />}
            Create account
          </button>

          {googleEnabled && (
            <>
              <AuthDivider />
              {/* Agreeing to the terms gates this too — the OAuth redirect
                  leaves the page, so the checkbox must be satisfied first. */}
              {accepted ? (
                <GoogleButton mode="signup" code={code} />
              ) : (
                <button type="button" className="btn-ghost w-full justify-center py-2.5" disabled>
                  Accept the terms to sign up with Google
                </button>
              )}
            </>
          )}
        </form>
      </main>
    </div>
  )
}
