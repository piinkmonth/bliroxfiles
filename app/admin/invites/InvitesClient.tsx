'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Copy, Check, Loader2, Ticket, Ban } from 'lucide-react'
import { formatBytes, formatRelative, formatDate } from '@/lib/format'

interface Invite {
  code: string
  note: string | null
  quotaBytes: number
  maxUses: number
  uses: number
  expiresAt: number | null
  createdAt: number
  creator: string | null
  redeemedBy: string | null
  state: 'active' | 'used' | 'expired' | 'revoked'
}

export function InvitesClient({
  invites,
  defaultQuotaGb,
}: {
  invites: Invite[]
  defaultQuotaGb: number
}) {
  const router = useRouter()
  const [note, setNote] = useState('')
  const [quotaGb, setQuotaGb] = useState(String(defaultQuotaGb))
  const [maxUses, setMaxUses] = useState('1')
  const [expiresInDays, setExpiresInDays] = useState('14')
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState<{ url: string; warning: string | null } | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function create(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setCreated(null)

    try {
      const res = await fetch('/api/admin/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          note: note || undefined,
          quotaGb: Number(quotaGb),
          maxUses: Number(maxUses),
          expiresInDays: expiresInDays ? Number(expiresInDays) : null,
        }),
      })
      const data = await res.json()
      if (!data.ok) {
        setError(data.error)
        return
      }
      setCreated({ url: data.invite.url, warning: data.warning })
      setNote('')
      router.refresh()
    } catch {
      setError('Could not reach the server')
    } finally {
      setBusy(false)
    }
  }

  async function revoke(code: string) {
    if (!confirm(`Revoke invite ${code}? It will stop working immediately.`)) return
    await fetch(`/api/admin/invites/${code}`, { method: 'DELETE' })
    router.refresh()
  }

  return (
    <div className="space-y-6">
      <section className="card p-5">
        <h2 className="flex items-center gap-2 font-medium">
          <Ticket size={16} className="text-accent" />
          Create an invite
        </h2>

        <form onSubmit={create} className="mt-4 grid gap-4 sm:grid-cols-4">
          <div className="sm:col-span-2">
            <label className="label" htmlFor="note">
              Who&rsquo;s it for
            </label>
            <input
              id="note"
              className="input"
              placeholder="e.g. dave from work"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={200}
            />
          </div>

          <div>
            <label className="label" htmlFor="quota">
              Storage (GB)
            </label>
            <input
              id="quota"
              type="number"
              className="input"
              value={quotaGb}
              onChange={(e) => setQuotaGb(e.target.value)}
              min={1}
              max={500}
              required
            />
          </div>

          <div>
            <label className="label" htmlFor="uses">
              Uses
            </label>
            <input
              id="uses"
              type="number"
              className="input"
              value={maxUses}
              onChange={(e) => setMaxUses(e.target.value)}
              min={1}
              max={50}
              required
            />
          </div>

          <div>
            <label className="label" htmlFor="expiry">
              Expires in (days)
            </label>
            <input
              id="expiry"
              type="number"
              className="input"
              value={expiresInDays}
              onChange={(e) => setExpiresInDays(e.target.value)}
              min={1}
              max={365}
              placeholder="never"
            />
          </div>

          <div className="flex items-end sm:col-span-3">
            <button type="submit" className="btn-primary" disabled={busy}>
              {busy && <Loader2 size={15} className="animate-spin" />}
              Generate invite link
            </button>
          </div>
        </form>

        {error && <p className="mt-3 text-sm text-danger">{error}</p>}

        {created && (
          <div className="mt-4 animate-fade-up rounded-lg border border-success/30 bg-success/5 p-4">
            <p className="text-sm font-medium text-success">Invite created</p>
            <CopyRow url={created.url} />
            {created.warning && <p className="mt-2 text-xs text-warn">{created.warning}</p>}
            <p className="mt-2 text-xs text-muted">
              Send this to one person. Whoever created it stays on the record as having vouched for
              them.
            </p>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 font-medium">All invites</h2>
        {invites.length === 0 ? (
          <div className="card p-8 text-center text-sm text-muted">No invites yet.</div>
        ) : (
          <div className="card divide-y divide-border">
            {invites.map((inv) => (
              <div key={inv.code} className="flex items-center gap-4 p-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <code className="font-mono text-sm">{inv.code}</code>
                    <StateBadge state={inv.state} />
                  </div>
                  <p className="mt-1 text-xs text-muted">
                    {inv.note && <>{inv.note} · </>}
                    {formatBytes(inv.quotaBytes)} · {inv.uses}/{inv.maxUses} used
                    {inv.creator && <> · by {inv.creator}</>}
                    {' · '}
                    {formatRelative(inv.createdAt)}
                    {inv.expiresAt && <> · expires {formatDate(inv.expiresAt)}</>}
                  </p>
                  {inv.redeemedBy && (
                    <p className="mt-0.5 text-xs text-muted">Redeemed by {inv.redeemedBy}</p>
                  )}
                </div>

                {inv.state === 'active' && (
                  <div className="flex shrink-0 items-center gap-1">
                    <CopyButton
                      url={
                        typeof window !== 'undefined'
                          ? `${window.location.origin}/join/${inv.code}`
                          : ''
                      }
                    />
                    <button
                      onClick={() => revoke(inv.code)}
                      className="rounded-lg p-2 text-muted hover:bg-danger/10 hover:text-danger"
                      title="Revoke"
                    >
                      <Ban size={15} />
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function StateBadge({ state }: { state: Invite['state'] }) {
  const styles: Record<Invite['state'], string> = {
    active: 'bg-success/15 text-success',
    used: 'bg-raised text-muted',
    expired: 'bg-raised text-muted',
    revoked: 'bg-danger/15 text-danger',
  }
  return <span className={`badge ${styles[state]}`}>{state}</span>
}

function CopyRow({ url }: { url: string }) {
  return (
    <div className="mt-2 flex items-center gap-2">
      <code className="flex-1 truncate rounded-lg bg-raised px-3 py-2 font-mono text-xs">{url}</code>
      <CopyButton url={url} labelled />
    </div>
  )
}

function CopyButton({ url, labelled = false }: { url: string; labelled?: boolean }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className={labelled ? 'btn-ghost' : 'rounded-lg p-2 text-muted hover:bg-raised hover:text-text'}
      title="Copy invite link"
      onClick={() => {
        navigator.clipboard.writeText(url)
        setCopied(true)
        setTimeout(() => setCopied(false), 1600)
      }}
    >
      {copied ? <Check size={15} className="text-success" /> : <Copy size={15} />}
      {labelled && (copied ? 'Copied' : 'Copy')}
    </button>
  )
}
