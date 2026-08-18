'use client'

import { useState } from 'react'
import { Copy, Check } from 'lucide-react'

/** A URL shown in full with a copy button beside it. */
export function CopyLink({ url, label }: { url: string; label?: string }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(url)
    } catch {
      // Clipboard access can be refused — the URL is selectable either way,
      // so there is nothing to recover from beyond not claiming success.
      return
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="flex items-stretch gap-1.5">
      <code
        className="min-w-0 flex-1 select-all truncate border border-border bg-raised/40 px-2 py-1.5 font-mono text-[11px] text-muted"
        title={url}
      >
        {url}
      </code>
      <button
        onClick={copy}
        className="shrink-0 border border-border px-2 text-muted transition-colors hover:bg-raised hover:text-text"
        aria-label={label ?? 'Copy link'}
        title={label ?? 'Copy link'}
      >
        {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
      </button>
    </div>
  )
}
