'use client'

import { useState } from 'react'
import { WordmarkClient } from '@/components/WordmarkClient'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Loader2 } from 'lucide-react'
import { ThemePicker } from '@/components/ThemePicker'
import { GoogleButton, AuthDivider } from '@/components/GoogleButton'

export function LoginForm({
  logoSrc,
  googleEnabled = false,
  initialError,
}: {
  logoSrc?: string | null
  googleEnabled?: boolean
  initialError?: string | null
}) {
  const router = useRouter()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  // Errors bounced back from the OAuth callback arrive as a query param.
  const [error, setError] = useState<string | null>(initialError ?? null)
  const [busy, setBusy] = useState(false)
  // Set once the password step succeeds on an account with 2FA.
  const [challenge, setChallenge] = useState<string | null>(null)
  const [code, setCode] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      const data = await res.json()
      if (!data.ok) {
        setError(data.error)
        return
      }
      if (data.requiresTwoFactor) {
        setChallenge(data.challenge)
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

  async function submitCode(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)

    try {
      const res = await fetch('/api/auth/2fa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challenge, code }),
      })
      const data = await res.json()
      if (!data.ok) {
        setError(data.error)
        return
      }
      if (data.usedBackup) {
        // Worth interrupting for: they are finite and cannot be regenerated
        // without turning 2FA off and on again.
        alert(`Backup code used. ${data.backupCodesRemaining} left.`)
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

      {/* Left-aligned and vertically centred, not a centred card in a void. */}
      <main className="flex flex-1 flex-col justify-center py-16">
        <h1 className="font-mono text-xl tracking-tight">Sign in</h1>

        {challenge ? null : googleEnabled ? (
          <div className="mt-8 max-w-sm space-y-5">
            <GoogleButton mode="login" />
            <AuthDivider label="or use a password" />
          </div>
        ) : null}

        {challenge ? (
          <form onSubmit={submitCode} className="mt-8 max-w-sm space-y-5">
            <div>
              <label className="label" htmlFor="code">
                Six-digit code
              </label>
              <input
                id="code"
                className="input text-center font-mono text-lg tracking-[0.4em]"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/[^0-9a-zA-Z-]/g, '').slice(0, 12))}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="000000"
                autoFocus
                required
              />
              <p className="mt-1.5 text-xs text-muted">
                From your authenticator app. A backup code works here too.
              </p>
            </div>

            {error && <p className="border-l-2 border-danger pl-3 text-sm text-danger">{error}</p>}

            <button type="submit" className="btn-primary w-full" disabled={busy}>
              {busy && <Loader2 size={15} className="animate-spin" />}
              Verify
            </button>
            <button
              type="button"
              className="font-mono text-[11px] text-muted hover:text-text"
              onClick={() => {
                setChallenge(null)
                setCode('')
                setError(null)
              }}
            >
              ← start over
            </button>
          </form>
        ) : (
        <form onSubmit={submit} className={`${googleEnabled ? 'mt-5' : 'mt-8'} max-w-sm space-y-5`}>
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
              autoFocus
              required
            />
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
              autoComplete="current-password"
              required
            />
          </div>

          {error && (
            <p className="border-l-2 border-danger pl-3 text-sm text-danger">{error}</p>
          )}

          <button type="submit" className="btn-primary w-full" disabled={busy}>
            {busy && <Loader2 size={15} className="animate-spin" />}
            Sign in
          </button>
        </form>
        )}
      </main>

      <footer className="max-w-sm border-t border-border pt-6 font-mono text-[11px] text-muted">
        invite only. you need a link from someone already here.
      </footer>
    </div>
  )
}
