'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { KeyRound, Plus, Copy, Check, Trash2, Loader2, TriangleAlert } from 'lucide-react'
import { formatRelative, formatDate } from '@/lib/format'
import type { ApiScope } from '@/lib/db'
import type { TokenView } from '@/lib/apiviews'

const SCOPE_LABELS: { id: ApiScope; label: string }[] = [
  { id: 'read', label: 'Read files and folders, download bytes' },
  { id: 'write', label: 'Upload, create folders, edit metadata' },
  { id: 'delete', label: 'Delete files and folders' },
]

const EXPIRY_OPTIONS: { label: string; days: number | null }[] = [
  { label: 'No expiry', days: null },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
  { label: '1 year', days: 365 },
]

/** Live if not revoked and not past its expiry. */
function isLive(t: TokenView): boolean {
  if (t.revokedAt) return false
  if (t.expiresAt && t.expiresAt < Date.now()) return false
  return true
}

function statusLabel(t: TokenView): string {
  if (t.revokedAt) return 'revoked'
  if (t.expiresAt && t.expiresAt < Date.now()) return 'expired'
  if (t.expiresAt) return `expires ${formatDate(t.expiresAt)}`
  return 'no expiry'
}

export function ApiTokensSection({ tokens }: { tokens: TokenView[] }) {
  const router = useRouter()

  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<Set<ApiScope>>(new Set(['read']))
  const [expiryDays, setExpiryDays] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The one-and-only reveal of a freshly minted secret.
  const [revealed, setRevealed] = useState<{ token: string; info: TokenView } | null>(null)
  const [copied, setCopied] = useState(false)
  const [revoking, setRevoking] = useState<string | null>(null)

  function toggleScope(s: ApiScope) {
    setScopes((prev) => {
      const next = new Set(prev)
      next.has(s) ? next.delete(s) : next.add(s)
      return next
    })
  }

  function resetForm() {
    setName('')
    setScopes(new Set(['read']))
    setExpiryDays(null)
    setOpen(false)
  }

  async function create(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (!name.trim()) return setError('A name is required')
    if (scopes.size === 0) return setError('Pick at least one scope')

    setBusy(true)
    const expiresAt = expiryDays ? Date.now() + expiryDays * 86400_000 : null

    try {
      const res = await fetch('/api/profile/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), scopes: [...scopes], expiresAt }),
      })
      const data = await res.json()
      if (!data.ok) {
        setError(data.error)
        return
      }
      setRevealed({ token: data.token, info: data.tokenInfo })
      setCopied(false)
      resetForm()
      router.refresh()
    } catch {
      setError('Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  async function revoke(id: string) {
    if (!confirm('Revoke this token? Anything using it stops working immediately.')) return
    setRevoking(id)
    try {
      const res = await fetch(`/api/profile/tokens/${id}`, { method: 'DELETE' })
      const data = await res.json()
      if (!data.ok) setError(data.error)
      else router.refresh()
    } finally {
      setRevoking(null)
    }
  }

  async function copy() {
    if (!revealed) return
    await navigator.clipboard.writeText(revealed.token)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <section className="card p-6">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 font-medium">
          <KeyRound size={16} className="text-muted" />
          API tokens
        </h2>
        <a href="/developers" className="text-xs text-accent hover:underline">
          Reference →
        </a>
      </div>
      <p className="mt-1 text-sm text-muted">Bearer tokens for the API. One secret per token, shown once.</p>

      {/* One-time reveal -------------------------------------------------- */}
      {revealed && (
        <div className="mt-5 rounded border border-accent/50 bg-accent/[0.06] p-4">
          <p className="flex items-center gap-2 text-sm font-medium text-accent">
            <TriangleAlert size={15} />
            Copy this now — it won&rsquo;t be shown again.
          </p>
          <div className="mt-3 flex items-stretch gap-2">
            <code className="flex-1 overflow-x-auto rounded border border-border bg-bg/60 px-3 py-2 font-mono text-xs">
              {revealed.token}
            </code>
            <button onClick={copy} className="btn-ghost shrink-0">
              {copied ? <Check size={15} className="text-success" /> : <Copy size={15} />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <button onClick={() => setRevealed(null)} className="mt-3 text-xs text-muted hover:text-text">
            Done
          </button>
        </div>
      )}

      {error && !open && (
        <p className="mt-4 border-l-2 border-danger pl-3 text-sm text-danger">{error}</p>
      )}

      {/* Token list ------------------------------------------------------- */}
      {tokens.length > 0 ? (
        <ul className="mt-5 divide-y divide-border">
          {tokens.map((t) => {
            const live = isLive(t)
            return (
              <li key={t.id} className={`flex items-center gap-3 py-3 ${live ? '' : 'opacity-50'}`}>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                    <span className="truncate font-medium">{t.name}</span>
                    <span className="font-mono text-[11px] text-muted">{t.prefix}…</span>
                    {t.scopes.map((s) => (
                      <span key={s} className="chip">
                        {s}
                      </span>
                    ))}
                  </p>
                  <p className="mt-1 font-mono text-[11px] text-muted">
                    {t.lastUsedAt ? `used ${formatRelative(t.lastUsedAt)}` : 'never used'} ·{' '}
                    {statusLabel(t)}
                  </p>
                </div>

                {live && (
                  <button
                    onClick={() => revoke(t.id)}
                    disabled={revoking === t.id}
                    className="shrink-0 rounded p-1.5 text-muted hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                    title="Revoke token"
                  >
                    {revoking === t.id ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Trash2 size={14} />
                    )}
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      ) : (
        !open && <p className="mt-5 text-sm text-muted">No tokens yet.</p>
      )}

      {/* Create form ------------------------------------------------------ */}
      {open ? (
        <form onSubmit={create} className="mt-5 space-y-4 border-t border-border pt-5">
          <div>
            <label className="label" htmlFor="token-name">
              Name
            </label>
            <input
              id="token-name"
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              placeholder="backup script"
              autoFocus
            />
          </div>

          <div>
            <span className="label">Scopes</span>
            <div className="space-y-2">
              {SCOPE_LABELS.map((s) => (
                <label key={s.id} className="flex cursor-pointer items-start gap-2.5 text-sm">
                  <input
                    type="checkbox"
                    checked={scopes.has(s.id)}
                    onChange={() => toggleScope(s.id)}
                    className="mt-0.5 accent-accent"
                  />
                  <span>
                    <span className="font-mono text-xs text-text">{s.id}</span>
                    <span className="ml-2 text-muted">{s.label}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div>
            <label className="label" htmlFor="token-expiry">
              Expiry
            </label>
            <select
              id="token-expiry"
              className="input"
              value={expiryDays ?? ''}
              onChange={(e) => setExpiryDays(e.target.value ? Number(e.target.value) : null)}
            >
              {EXPIRY_OPTIONS.map((o) => (
                <option key={o.label} value={o.days ?? ''}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          {error && <p className="border-l-2 border-danger pl-3 text-sm text-danger">{error}</p>}

          <div className="flex items-center gap-2">
            <button type="submit" className="btn-primary" disabled={busy}>
              {busy && <Loader2 size={15} className="animate-spin" />}
              Create token
            </button>
            <button
              type="button"
              onClick={resetForm}
              className="btn-ghost"
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button onClick={() => setOpen(true)} className="btn-ghost mt-5">
          <Plus size={15} />
          New token
        </button>
      )}
    </section>
  )
}
