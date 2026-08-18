'use client'

import { useState } from 'react'
import { ShieldAlert, X, Loader2 } from 'lucide-react'
import { countryLabel } from '@/lib/geo'
import type { SecurityNotice } from '@/lib/auth'

/**
 * Modal shown once for anything the account holder needs told about.
 *
 * Rendered from the dashboard rather than from the login form so it catches
 * every way into the app — password, second factor, and Google alike — with
 * one code path. It stays up until dismissed: a warning that a session was
 * killed is the sort of thing that should cost a deliberate click.
 */
export function SecurityNotices({ notices }: { notices: SecurityNotice[] }) {
  const [open, setOpen] = useState(notices.length > 0)
  const [dismissing, setDismissing] = useState(false)

  if (!open || notices.length === 0) return null

  async function dismiss() {
    setDismissing(true)
    try {
      await fetch('/api/security/notices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: notices.map((n) => n.id) }),
      })
    } catch {
      // Dismissing locally regardless — a failed acknowledgement means it
      // reappears next load, which is the harmless direction to fail in.
    }
    setOpen(false)
    setDismissing(false)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="security-notice-title"
    >
      <div className="card-solid w-full max-w-md border-danger/50 p-6">
        <div className="flex items-start gap-3">
          <ShieldAlert size={20} className="mt-0.5 shrink-0 text-danger" />
          <div className="min-w-0 flex-1">
            <h2 id="security-notice-title" className="font-mono text-sm text-danger">
              Security notice
            </h2>

            <div className="mt-3 space-y-4">
              {notices.map((n) => (
                <NoticeBody key={n.id} notice={n} />
              ))}
            </div>
          </div>

          <button
            onClick={dismiss}
            className="shrink-0 text-muted hover:text-text"
            aria-label="Dismiss"
          >
            <X size={16} />
          </button>
        </div>

        <button onClick={dismiss} disabled={dismissing} className="btn-primary mt-6 w-full py-2.5">
          {dismissing && <Loader2 size={14} className="animate-spin" />}
          I understand
        </button>
      </div>
    </div>
  )
}

function NoticeBody({ notice }: { notice: SecurityNotice }) {
  const when = new Date(notice.createdAt).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })

  if (notice.kind === 'session.geo_revoked') {
    const from = notice.detail?.from as string | undefined
    const to = notice.detail?.to as string | undefined

    return (
      <div className="text-sm leading-relaxed">
        <p>
          One of your sessions was signed out for security reasons. It was created in{' '}
          <strong>{countryLabel(from)}</strong>, then started being used from{' '}
          <strong>{countryLabel(to)}</strong>.
        </p>
        <p className="mt-2 text-muted">
          If that was you — travelling, or switching a VPN on or off — nothing is wrong and you can
          sign back in normally. You can turn this check off in Settings → Security.
        </p>
        <p className="mt-2 text-muted">
          If it was not you, someone else had your session cookie.{' '}
          <strong className="text-text">Change your password now</strong> and turn on two-factor
          authentication.
        </p>
        <p className="mt-2 font-mono text-[11px] text-muted">{when}</p>
      </div>
    )
  }

  return (
    <div className="text-sm leading-relaxed">
      <p>{notice.kind}</p>
      <p className="mt-1 font-mono text-[11px] text-muted">{when}</p>
    </div>
  )
}
