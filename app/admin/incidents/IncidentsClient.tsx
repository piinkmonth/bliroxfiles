'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { FileWarning, Check, Copy, Loader2, ExternalLink } from 'lucide-react'
import { formatDate, formatRelative } from '@/lib/format'

interface Incident {
  id: string
  category: string
  evidence: string
  preserved: boolean
  preserveUntil: number | null
  ncmecStatus: 'pending' | 'submitted' | 'n/a'
  ncmecReportId: string | null
  notes: string | null
  createdAt: number
  submittedAt: number | null
  uploader: string | null
}

export function IncidentsClient({ incidents }: { incidents: Incident[] }) {
  const pending = incidents.filter((i) => i.ncmecStatus === 'pending')

  return (
    <div className="space-y-6">
      <section className="card border-border p-5">
        <h2 className="flex items-center gap-2 font-medium">
          <FileWarning size={16} className="text-warn" />
          What this page is for
        </h2>
        <div className="mt-3 space-y-2 text-sm leading-relaxed text-muted">
          <p>
            Every quarantined file gets an incident record here, with a frozen snapshot of the file,
            the uploader, and the invite chain that led to them. That snapshot survives the account
            and the file being deleted.
          </p>
          <p>
            For anything in the CSAM category, US federal law (18 U.S.C. § 2258A) requires a
            provider to report to NCMEC&rsquo;s CyberTipline once it has actual knowledge, and to
            preserve the content and related data for 90 days after reporting. This tool tracks
            that; it does not do it for you.
          </p>
          <p className="text-text">
            Report at{' '}
            <a
              href="https://report.cybertip.org/"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-accent hover:underline"
            >
              report.cybertip.org
              <ExternalLink size={12} />
            </a>
            . Registering as an Electronic Service Provider with NCMEC ahead of time makes that
            process considerably less painful than doing it for the first time under pressure.
          </p>
        </div>
      </section>

      {pending.length > 0 && (
        <div className="rounded-card border border-danger bg-danger/10 p-4 text-sm">
          <p className="font-medium text-danger">
            {pending.length} incident{pending.length === 1 ? '' : 's'} not yet reported
          </p>
          <p className="mt-1 text-muted">
            The preservation clock starts when you submit, so these are also holding disk space
            indefinitely until they&rsquo;re resolved.
          </p>
        </div>
      )}

      {incidents.length === 0 ? (
        <div className="card p-12 text-center text-muted">No incidents on record.</div>
      ) : (
        <div className="space-y-3">
          {incidents.map((incident) => (
            <IncidentCard key={incident.id} incident={incident} />
          ))}
        </div>
      )}
    </div>
  )
}

function IncidentCard({ incident }: { incident: Incident }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [reportId, setReportId] = useState(incident.ncmecReportId ?? '')
  const [notes, setNotes] = useState(incident.notes ?? '')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  const isCsam = incident.category === 'csam'
  const isPending = incident.ncmecStatus === 'pending'

  async function save(status?: 'submitted') {
    setBusy(true)
    await fetch(`/api/admin/incidents/${incident.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ncmecStatus: status,
        ncmecReportId: reportId || undefined,
        notes: notes || undefined,
      }),
    })
    setBusy(false)
    router.refresh()
  }

  return (
    <div className={`card p-5 ${isPending && isCsam ? 'border-danger ring-1 ring-danger/30' : ''}`}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <code className="font-mono text-sm">{incident.id}</code>
            <span
              className={`badge ${
                isPending
                  ? 'bg-danger/15 text-danger'
                  : incident.ncmecStatus === 'submitted'
                    ? 'bg-success/15 text-success'
                    : 'bg-raised text-muted'
              }`}
            >
              {incident.ncmecStatus === 'n/a' ? 'no report needed' : incident.ncmecStatus}
            </span>
            <span className="badge bg-raised text-muted">{incident.category}</span>
          </div>

          <p className="mt-2 text-xs text-muted">
            Opened {formatRelative(incident.createdAt)}
            {incident.uploader && <> · uploader {incident.uploader}</>}
            {incident.submittedAt && <> · reported {formatDate(incident.submittedAt)}</>}
          </p>

          <p className="mt-1 text-xs text-muted">
            {incident.preserved ? (
              <>
                Content preserved
                {incident.preserveUntil && <> until {formatDate(incident.preserveUntil)}</>}
              </>
            ) : (
              'Content no longer held'
            )}
          </p>
        </div>

        <button onClick={() => setOpen((v) => !v)} className="btn-ghost shrink-0">
          {open ? 'Hide' : 'Details'}
        </button>
      </div>

      {open && (
        <div className="mt-4 space-y-4">
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-sm font-medium">Evidence snapshot</span>
              <button
                className="btn-ghost text-xs"
                onClick={() => {
                  navigator.clipboard.writeText(incident.evidence)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1600)
                }}
              >
                {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
                {copied ? 'Copied' : 'Copy for report'}
              </button>
            </div>
            <pre className="max-h-72 overflow-auto rounded-lg bg-raised p-3 font-mono text-xs">
              {incident.evidence}
            </pre>
          </div>

          {isCsam && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor={`rid-${incident.id}`}>
                  CyberTipline report ID
                </label>
                <input
                  id={`rid-${incident.id}`}
                  className="input"
                  value={reportId}
                  onChange={(e) => setReportId(e.target.value)}
                  placeholder="from report.cybertip.org"
                />
              </div>
              <div>
                <label className="label" htmlFor={`notes-${incident.id}`}>
                  Notes
                </label>
                <input
                  id={`notes-${incident.id}`}
                  className="input"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="anything worth recording"
                />
              </div>
            </div>
          )}

          <div className="flex gap-2">
            <button onClick={() => save()} className="btn-ghost" disabled={busy}>
              {busy && <Loader2 size={14} className="animate-spin" />}
              Save
            </button>
            {isCsam && isPending && (
              <button onClick={() => save('submitted')} className="btn-primary" disabled={busy}>
                <Check size={14} />
                Mark as reported to NCMEC
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
