'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Globe2, Loader2, MonitorSmartphone, LogOut } from 'lucide-react'
import { countryFlag, countryName } from '@/lib/geo'
import { formatRelative } from '@/lib/format'
import type { SessionSummary } from '@/lib/auth'

/**
 * A user agent is a wall of text nobody reads. This pulls out the two things
 * that actually distinguish one of your own devices from another.
 */
function describeAgent(ua: string | null): string {
  if (!ua) return 'Unknown device'

  const os =
    /Windows/.test(ua) ? 'Windows'
    : /Android/.test(ua) ? 'Android'
    : /iPhone|iPad|iOS/.test(ua) ? 'iOS'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /Linux/.test(ua) ? 'Linux'
    : 'Unknown OS'

  // Order matters: Edge and Chrome both claim to be Safari, Edge also claims
  // to be Chrome. Test from most specific to least.
  const browser =
    /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : 'Unknown browser'

  return `${browser} on ${os}`
}

export function SecuritySection({
  geoGuard,
  sessions,
}: {
  geoGuard: boolean
  sessions: SessionSummary[]
}) {
  const router = useRouter()
  const [enabled, setEnabled] = useState(geoGuard)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function toggleGuard(next: boolean) {
    setBusy('guard')
    setError(null)
    // Optimistic: the switch should move under the finger, not after a round trip.
    setEnabled(next)

    const res = await fetch('/api/security/sessions', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ geoGuard: next }),
    })
    const data = await res.json()

    setBusy(null)
    if (!data.ok) {
      setEnabled(!next)
      setError(data.error)
      return
    }
    router.refresh()
  }

  async function revoke(token: string | null) {
    const msg = token
      ? 'Sign out this session?'
      : 'Sign out every other session? Devices other than this one will need to sign in again.'
    if (!confirm(msg)) return

    setBusy(token ?? 'all')
    setError(null)

    const res = await fetch(
      `/api/security/sessions${token ? `?token=${encodeURIComponent(token)}` : ''}`,
      { method: 'DELETE' },
    )
    const data = await res.json()

    setBusy(null)
    if (!data.ok) {
      setError(data.error)
      return
    }
    router.refresh()
  }

  const others = sessions.filter((s) => !s.current).length

  return (
    <section className="card p-6">
      <h2 className="font-medium">Security</h2>

      {/* Geo guard -------------------------------------------------------- */}
      <div className="mt-5 flex items-start gap-4">
        <Globe2 size={18} className="mt-0.5 shrink-0 text-muted" />
        <div className="min-w-0 flex-1">
          <label htmlFor="geo-guard" className="cursor-pointer font-medium">
            Sign out on location change
          </label>
          <p className="mt-1 text-sm leading-relaxed text-muted">
            If a signed-in session starts being used from a different country, that session is
            signed out and you are told about it the next time you sign in. Other devices are not
            affected.
          </p>
          <p className="mt-2 text-xs leading-relaxed text-muted">
            Turn this off if you use a VPN that moves you between countries, or travel often —
            otherwise it will sign you out regularly. It never triggers when the country cannot be
            determined.
          </p>
        </div>

        <button
          id="geo-guard"
          role="switch"
          aria-checked={enabled}
          onClick={() => toggleGuard(!enabled)}
          disabled={busy === 'guard'}
          className={`relative mt-1 h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
            enabled ? 'bg-accent' : 'bg-border'
          }`}
        >
          <span className="sr-only">Sign out on location change</span>
          <span
            className={`absolute top-1 h-4 w-4 rounded-full bg-white transition-transform ${
              enabled ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      </div>

      {error && <p className="mt-4 border-l-2 border-danger pl-3 text-sm text-danger">{error}</p>}

      {/* Sessions --------------------------------------------------------- */}
      <div className="mt-8 border-t border-border pt-5">
        <div className="flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <MonitorSmartphone size={15} className="text-muted" />
            Active sessions
          </h3>
          {others > 0 && (
            <button
              onClick={() => revoke(null)}
              disabled={busy === 'all'}
              className="btn-ghost text-xs text-danger"
            >
              {busy === 'all' && <Loader2 size={12} className="animate-spin" />}
              Sign out others ({others})
            </button>
          )}
        </div>

        <ul className="mt-3 divide-y divide-border">
          {sessions.map((s) => (
            <li key={s.token} className="flex items-center gap-3 py-3">
              <span className="text-lg leading-none" title={countryName(s.country)}>
                {countryFlag(s.country)}
              </span>

              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">
                  {describeAgent(s.userAgent)}
                  {s.current && (
                    <span className="ml-2 rounded bg-accent/15 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-accent">
                      this device
                    </span>
                  )}
                </p>
                <p className="font-mono text-[11px] text-muted">
                  {countryName(s.country)} · started {formatRelative(s.createdAt)}
                </p>
              </div>

              {!s.current && (
                <button
                  onClick={() => revoke(s.token)}
                  disabled={busy === s.token}
                  className="shrink-0 rounded p-1.5 text-muted hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                  title="Sign out this session"
                >
                  {busy === s.token ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <LogOut size={14} />
                  )}
                </button>
              )}
            </li>
          ))}
        </ul>

        <p className="mt-3 text-xs text-muted">
          Only the country is recorded against a session. Your address is stored encrypted and is
          not shown anywhere, including to staff.
        </p>
      </div>
    </section>
  )
}
