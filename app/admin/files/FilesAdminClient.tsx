'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { BadgeCheck, Search, ShieldAlert, ExternalLink, Loader2, Lock } from 'lucide-react'
import { formatBytes, formatRelative } from '@/lib/format'

interface AdminFile {
  id: string
  slug: string
  name: string
  sizeBytes: number
  mime: string | null
  sha256: string
  createdAt: number
  country: string | null
  encrypted: boolean
  verified: boolean
  verifiedNote: string | null
  verifiedBy: string | null
  scanVerdict: string | null
  downloads: number
  owner: string
}

function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(undefined, { type: 'region' }).of(code) ?? code
  } catch {
    return code
  }
}

/** Turn the stored verdict string into something readable at a glance. */
function scanLabel(verdict: string | null): { text: string; tone: string } {
  if (!verdict) return { text: 'not scanned', tone: 'text-muted' }
  if (verdict.startsWith('clean')) {
    return { text: `clean (${verdict.split(':')[1] ?? 'scanner'})`, tone: 'text-success' }
  }
  if (verdict === 'infected') return { text: 'infected', tone: 'text-danger' }
  if (verdict === 'skipped-encrypted') return { text: 'encrypted — not scannable', tone: 'text-muted' }
  if (verdict === 'unscanned') return { text: 'no scanner configured', tone: 'text-warn' }
  return { text: verdict, tone: 'text-warn' }
}

export function FilesAdminClient({
  files,
  view,
  query,
  counts,
}: {
  files: AdminFile[]
  view: 'active' | 'quarantined'
  query: string
  counts: { active: number; quarantined: number }
}) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [search, setSearch] = useState(query)

  async function toggleVerify(file: AdminFile) {
    let note: string | null = null
    if (!file.verified) {
      note = prompt(
        `Mark "${file.name}" as verified?\n\n` +
          `This tells anyone with the link that staff looked at it and it is what it claims to be. ` +
          `Optional note shown on hover:`,
      )
      if (note === null) return
    } else if (!confirm(`Remove the verified badge from "${file.name}"?`)) {
      return
    }

    setBusy(file.id)
    const res = await fetch(`/api/admin/files/${file.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verified: !file.verified, note: note || undefined }),
    })
    const data = await res.json()
    setBusy(null)
    if (!data.ok) alert(data.error)
    router.refresh()
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Tab href="/admin/files" active={view === 'active'}>
          active <span className="opacity-60">{counts.active}</span>
        </Tab>
        <Tab href="/admin/files?view=quarantined" active={view === 'quarantined'}>
          quarantined <span className="opacity-60">{counts.quarantined}</span>
        </Tab>

        <form className="relative ml-auto w-64" action="/admin/files">
          {view === 'quarantined' && <input type="hidden" name="view" value="quarantined" />}
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            name="q"
            className="input pl-9"
            placeholder="Search name or uploader"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </form>
      </div>

      {view === 'quarantined' && (
        <div className="border-l-2 border-danger pl-4 text-sm text-muted">
          <p className="flex items-center gap-2 font-medium text-danger">
            <ShieldAlert size={15} />
            Removed from circulation
          </p>
          <p className="mt-1">
            These are no longer downloadable and their hashes are blocklisted. Content is preserved
            rather than deleted — see <Link href="/admin/incidents" className="text-accent hover:underline">incidents</Link> for
            the evidence records and NCMEC status.
          </p>
        </div>
      )}

      {files.length === 0 ? (
        <div className="card p-12 text-center font-mono text-xs text-muted">
          {query ? 'nothing matches that search' : `no ${view} files`}
        </div>
      ) : (
        <div className="card-solid overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border font-mono text-[11px] uppercase tracking-wide text-muted">
                <th className="py-2 pl-3 text-left font-medium">file</th>
                <th className="py-2 text-left font-medium">uploader</th>
                <th className="py-2 text-left font-medium">scan</th>
                <th className="py-2 text-right font-medium">size</th>
                <th className="py-2 text-right font-medium">added</th>
                <th className="w-32 py-2 pr-3 text-right font-medium">actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {files.map((file) => {
                const scan = scanLabel(file.scanVerdict)
                return (
                  <tr key={file.id} className={busy === file.id ? 'opacity-50' : ''}>
                    <td className="min-w-0 py-2.5 pl-3">
                      <div className="flex items-center gap-1.5">
                        {file.encrypted && <Lock size={11} className="shrink-0 text-accent" />}
                        {file.verified && (
                          <BadgeCheck size={12} className="shrink-0 text-accent" aria-label="verified" />
                        )}
                        <span className="truncate" title={file.name}>
                          {file.name}
                        </span>
                      </div>
                      <div className="mt-0.5 truncate font-mono text-[10px] text-muted">
                        {file.sha256.slice(0, 24)}…
                        {file.country && ` · ${countryName(file.country)}`}
                        {file.verifiedBy && ` · verified by ${file.verifiedBy}`}
                      </div>
                    </td>
                    <td className="py-2.5 text-xs">{file.owner}</td>
                    <td className={`py-2.5 font-mono text-[11px] ${scan.tone}`}>{scan.text}</td>
                    <td className="whitespace-nowrap py-2.5 text-right font-mono text-xs text-muted">
                      {formatBytes(file.sizeBytes)}
                    </td>
                    <td className="whitespace-nowrap py-2.5 text-right font-mono text-xs text-muted">
                      {formatRelative(file.createdAt)}
                    </td>
                    <td className="py-2.5 pr-3">
                      <div className="flex justify-end gap-1">
                        {view === 'active' && (
                          <button
                            onClick={() => toggleVerify(file)}
                            disabled={busy === file.id || file.encrypted}
                            title={
                              file.encrypted
                                ? 'Encrypted files cannot be verified'
                                : file.verified
                                  ? 'Remove verification'
                                  : 'Mark verified'
                            }
                            className={`rounded p-1.5 transition-colors disabled:opacity-25 ${
                              file.verified
                                ? 'text-accent hover:bg-raised'
                                : 'text-muted hover:bg-raised hover:text-text'
                            }`}
                          >
                            {busy === file.id ? (
                              <Loader2 size={14} className="animate-spin" />
                            ) : (
                              <BadgeCheck size={14} />
                            )}
                          </button>
                        )}
                        <a
                          href={`/f/${file.slug}`}
                          target="_blank"
                          rel="noreferrer"
                          title="Open file page"
                          className="rounded p-1.5 text-muted hover:bg-raised hover:text-text"
                        >
                          <ExternalLink size={14} />
                        </a>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function Tab({
  href,
  active,
  children,
}: {
  href: string
  active: boolean
  children: React.ReactNode
}) {
  return (
    <Link
      href={href}
      className={`rounded px-3 py-1.5 font-mono text-xs transition-colors ${
        active ? 'bg-raised text-text' : 'text-muted hover:text-text'
      }`}
    >
      {children}
    </Link>
  )
}
