'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ShieldAlert, Loader2, Trash2, X, ExternalLink } from 'lucide-react'
import { formatBytes, formatRelative } from '@/lib/format'

interface Report {
  id: string
  category: 'csam' | 'malware' | 'copyright' | 'other'
  detail: string | null
  createdAt: number
  reporter: string
  file: {
    id: string
    name: string
    slug: string
    sizeBytes: number
    mime: string | null
    sha256: string
    downloads: number
  } | null
  owner: { id: string; username: string; status: string; chain: string[] } | null
}

const CATEGORY_LABEL: Record<Report['category'], string> = {
  csam: 'Child sexual abuse material',
  malware: 'Malware / scam',
  copyright: 'Copyright',
  other: 'Other',
}

export function ModerationClient({ reports }: { reports: Report[] }) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)

  async function resolve(report: Report, action: 'quarantine' | 'dismiss') {
    const isCsam = report.category === 'csam'

    if (action === 'quarantine') {
      const message = isCsam
        ? `Quarantine this file and suspend ${report.owner?.username ?? 'the uploader'}?\n\n` +
          `The file is moved out of reach but PRESERVED for 90 days, its hashes are blocked ` +
          `permanently, and an incident is opened for CyberTipline reporting.\n\n` +
          `You must then file that report — it is a legal obligation, not optional.`
        : `Quarantine "${report.file?.name}"? Its hashes will be blocked permanently.`
      if (!confirm(message)) return
    }

    setBusy(report.id)
    const resolution = action === 'quarantine' ? prompt('Note for the record (optional):') : null

    await fetch(`/api/admin/reports/${report.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, resolution: resolution ?? undefined }),
    })

    setBusy(null)
    router.refresh()
  }

  if (reports.length === 0) {
    return (
      <div className="card p-12 text-center">
        <p className="text-muted">Nothing in the queue.</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {reports.map((report) => {
        const urgent = report.category === 'csam'
        return (
          <div
            key={report.id}
            className={`card p-5 ${urgent ? 'border-danger ring-1 ring-danger/30' : ''}`}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  {urgent && <ShieldAlert size={16} className="shrink-0 text-danger" />}
                  <span className={`font-medium ${urgent ? 'text-danger' : ''}`}>
                    {CATEGORY_LABEL[report.category]}
                  </span>
                  <span className="text-xs text-muted">{formatRelative(report.createdAt)}</span>
                </div>

                {report.file ? (
                  <div className="mt-3">
                    <p className="break-words font-medium">{report.file.name}</p>
                    <p className="mt-0.5 text-xs text-muted">
                      {formatBytes(report.file.sizeBytes)} · {report.file.mime || 'unknown type'} ·{' '}
                      {report.file.downloads} download{report.file.downloads === 1 ? '' : 's'}
                    </p>
                    <p className="mt-1 break-all font-mono text-xs text-muted">
                      {report.file.sha256}
                    </p>
                  </div>
                ) : (
                  <p className="mt-3 text-sm text-muted">The file is already gone.</p>
                )}

                {report.detail && (
                  <p className="mt-3 rounded-lg bg-raised px-3 py-2 text-sm">{report.detail}</p>
                )}

                <p className="mt-3 text-xs text-muted">Reported by {report.reporter}</p>

                {report.owner && (
                  <div className="mt-3 rounded-lg bg-raised p-3 text-xs">
                    <p>
                      <span className="text-muted">Uploaded by</span>{' '}
                      <span className="font-medium">{report.owner.username}</span>
                      {report.owner.status !== 'active' && (
                        <span className="ml-1.5 badge bg-danger/15 text-danger">
                          {report.owner.status}
                        </span>
                      )}
                    </p>
                    {report.owner.chain.length > 1 && (
                      <p className="mt-1 text-muted">
                        Invite chain: {report.owner.chain.join(' ← ')}
                      </p>
                    )}
                  </div>
                )}

                {urgent && (
                  <p className="mt-3 text-xs leading-relaxed text-danger">
                    Do not download this to &ldquo;verify&rdquo; it. Act on the report, then file
                    with NCMEC — reviewing the file yourself is neither required nor safe.
                  </p>
                )}
              </div>

              {report.file && (
                <a
                  href={`/f/${report.file.slug}`}
                  target="_blank"
                  rel="noreferrer"
                  className="shrink-0 rounded-lg p-2 text-muted hover:bg-raised hover:text-text"
                  title="Open the file's page (does not download it)"
                >
                  <ExternalLink size={15} />
                </a>
              )}
            </div>

            <div className="mt-4 flex gap-2">
              <button
                onClick={() => resolve(report, 'quarantine')}
                className="btn-danger"
                disabled={busy === report.id || !report.file}
              >
                {busy === report.id ? (
                  <Loader2 size={15} className="animate-spin" />
                ) : (
                  <Trash2 size={15} />
                )}
                Quarantine &amp; block
              </button>

              <button
                onClick={() => resolve(report, 'dismiss')}
                className="btn-ghost"
                disabled={busy === report.id}
              >
                <X size={15} />
                Dismiss
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
