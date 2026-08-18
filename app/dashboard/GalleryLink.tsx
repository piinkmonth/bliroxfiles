'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { LayoutGrid, Loader2, Copy, Check, ExternalLink } from 'lucide-react'

/**
 * Publish a folder as a single browsable page.
 *
 * Withdrawing mints nothing — the token is cleared, so the old URL stops
 * corresponding to a folder rather than merely being refused. Publishing again
 * produces a different link, which is stated plainly because someone expecting
 * an old link to come back to life would otherwise be surprised by it.
 */
export function GalleryLink({
  folderId,
  token,
}: {
  folderId: string
  token: string | null
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const url = token && typeof window !== 'undefined' ? `${window.location.origin}/g/${token}` : null

  async function toggle() {
    if (token && !confirm('Withdraw this gallery link?\n\nThe current URL stops working. Publishing again creates a different one.')) {
      return
    }

    setBusy(true)
    setError(null)

    const res = await fetch(`/api/folders/${folderId}/gallery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !token }),
    })
    const data = await res.json()

    setBusy(false)
    if (!data.ok) {
      setError(data.error)
      return
    }
    router.refresh()
  }

  async function copy() {
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
    } catch {
      return
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <section className="card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <LayoutGrid size={15} className="shrink-0 text-muted" />
        <span className="text-sm font-medium">Gallery link</span>
        <span className="font-mono text-[11px] text-muted">
          {token ? 'published' : 'not published'}
        </span>

        <button onClick={toggle} disabled={busy} className="btn-ghost ml-auto shrink-0 text-xs">
          {busy && <Loader2 size={13} className="animate-spin" />}
          {token ? 'Withdraw' : 'Publish'}
        </button>
      </div>

      {token && url && (
        <div className="mt-3 flex items-stretch gap-1.5">
          <code className="min-w-0 flex-1 select-all truncate border border-border bg-raised/40 px-2 py-1.5 font-mono text-[11px] text-muted">
            {url}
          </code>
          <button
            onClick={copy}
            className="shrink-0 border border-border px-2 text-muted hover:bg-raised hover:text-text"
            aria-label="Copy gallery link"
            title="Copy gallery link"
          >
            {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
          </button>
          <a
            href={`/g/${token}`}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 border border-border px-2 py-1.5 text-muted hover:bg-raised hover:text-text"
            aria-label="Open gallery"
            title="Open gallery"
          >
            <ExternalLink size={13} />
          </a>
        </div>
      )}

      <p className="mt-2 text-xs leading-relaxed text-muted">
        {token
          ? 'Anyone with this link sees a grid of the files in this folder. Files you marked private, password-protected, or encrypted are left out.'
          : 'Publishes this folder as one page instead of one link per file. Only link-shareable files appear on it.'}
      </p>

      {error && <p className="mt-3 border-l-2 border-danger pl-3 text-sm text-danger">{error}</p>}
    </section>
  )
}
