import Link from 'next/link'
import { db } from '@/lib/db'
import { diskState, DISK_RESERVE_BYTES } from '@/lib/storage'
import { egressByDay } from '@/lib/egress'
import { formatBytes, formatRelative } from '@/lib/format'

export const dynamic = 'force-dynamic'

export default function AdminOverview() {
  const disk = diskState()

  const counts = db()
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM users WHERE status = 'active')     AS active_users,
         (SELECT COUNT(*) FROM users WHERE status = 'suspended')  AS suspended_users,
         (SELECT COUNT(*) FROM users WHERE status = 'banned')     AS banned_users,
         (SELECT COUNT(*) FROM files WHERE status = 'active')     AS files,
         (SELECT COUNT(*) FROM reports WHERE status = 'open')     AS open_reports,
         (SELECT COUNT(*) FROM incidents WHERE ncmec_status = 'pending') AS pending_incidents,
         (SELECT COUNT(*) FROM blocklist)                         AS blocked,
         (SELECT COUNT(*) FROM upload_sessions WHERE status = 'open') AS uploads_in_flight`,
    )
    .get() as Record<string, number>

  const egress = egressByDay(7)
  const todayBytes = egress[0]?.bytes ?? 0
  const weekBytes = egress.reduce((n, d) => n + d.bytes, 0)

  const diskPct = disk.totalBytes > 0 ? (disk.usedBytes / disk.totalBytes) * 100 : 0
  const lowSpace = disk.freeBytes < DISK_RESERVE_BYTES * 2

  const recentUsers = db()
    .prepare(
      `SELECT u.username, u.created_at, u.status, i.username AS inviter
       FROM users u LEFT JOIN users i ON i.id = u.invited_by
       ORDER BY u.created_at DESC LIMIT 5`,
    )
    .all() as { username: string; created_at: number; status: string; inviter: string | null }[]

  return (
    <div className="space-y-6">
      {counts.pending_incidents > 0 && (
        <Link
          href="/admin/incidents"
          className="block rounded-card border border-danger bg-danger/10 p-4 hover:bg-danger/15"
        >
          <p className="font-medium text-danger">
            {counts.pending_incidents} incident{counts.pending_incidents === 1 ? '' : 's'} awaiting
            a CyberTipline report
          </p>
          <p className="mt-1 text-sm text-muted">
            Reporting is a legal obligation, not a queue item. Open these now.
          </p>
        </Link>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Active users" value={String(counts.active_users)} />
        <Stat label="Files stored" value={String(counts.files)} />
        <Stat
          label="Open reports"
          value={String(counts.open_reports)}
          tone={counts.open_reports > 0 ? 'warn' : undefined}
          href="/admin/moderation"
        />
        <Stat label="Blocked hashes" value={String(counts.blocked)} />
      </div>

      {/* Disk ------------------------------------------------------------ */}
      <section className="card p-5">
        <div className="flex items-baseline justify-between">
          <h2 className="font-medium">Storage</h2>
          <span className="text-sm text-muted">
            {formatBytes(disk.usedBytes)} of {formatBytes(disk.totalBytes)} used
          </span>
        </div>

        <div className="mt-3 h-2 overflow-hidden bg-raised">
          <div
            className={`h-full ${
              diskPct > 90 ? 'bg-danger' : diskPct > 75 ? 'bg-warn' : 'bg-success'
            }`}
            style={{ width: `${Math.min(100, diskPct)}%` }}
          />
        </div>

        <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-muted">Free</dt>
            <dd className={`font-medium ${lowSpace ? 'text-danger' : ''}`}>
              {formatBytes(disk.freeBytes)}
            </dd>
          </div>
          <div>
            <dt className="text-muted">Allocated to accounts</dt>
            <dd className="font-medium">{formatBytes(disk.allocatedBytes)}</dd>
          </div>
          <div>
            <dt className="text-muted">Overcommit</dt>
            <dd
              className={`font-medium ${
                disk.overcommitRatio > 3 ? 'text-warn' : ''
              }`}
            >
              {disk.overcommitRatio.toFixed(2)}&times;
            </dd>
          </div>
        </dl>

        <p className="mt-4 text-xs leading-relaxed text-muted">
          Quota is overcommitted on purpose — accounts are promised more in total than the disk
          holds, on the assumption most stay well under. That works until it doesn&rsquo;t: at{' '}
          {formatBytes(DISK_RESERVE_BYTES)} free, new uploads are refused regardless of what
          individual accounts have left.
          {lowSpace && (
            <strong className="text-danger">
              {' '}
              You are close to that line now — free space or stop issuing invites.
            </strong>
          )}
        </p>
      </section>

      {/* Bandwidth ------------------------------------------------------- */}
      <section className="card p-5">
        <h2 className="font-medium">Bandwidth served</h2>
        <dl className="mt-3 grid gap-4 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted">Today</dt>
            <dd className="text-lg font-medium">{formatBytes(todayBytes)}</dd>
          </div>
          <div>
            <dt className="text-muted">Last 7 days</dt>
            <dd className="text-lg font-medium">{formatBytes(weekBytes)}</dd>
          </div>
        </dl>
        {egress.length > 0 && (
          <div className="mt-4 flex h-16 items-end gap-1">
            {[...egress].reverse().map((d) => {
              const max = Math.max(...egress.map((e) => e.bytes), 1)
              return (
                <div
                  key={d.day}
                  className="flex-1 rounded-t bg-accent/60"
                  style={{ height: `${Math.max(4, (d.bytes / max) * 100)}%` }}
                  title={`${d.day}: ${formatBytes(d.bytes)}`}
                />
              )
            })}
          </div>
        )}
        <p className="mt-3 text-xs text-muted">
          This all leaves through your home uplink. Sustained numbers here are what an ISP notices.
        </p>
      </section>

      {/* Recent signups -------------------------------------------------- */}
      <section className="card p-5">
        <h2 className="font-medium">Newest accounts</h2>
        {recentUsers.length === 0 ? (
          <p className="mt-3 text-sm text-muted">Nobody has joined yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-border text-sm">
            {recentUsers.map((u) => (
              <li key={u.username} className="flex items-center justify-between py-2">
                <span>
                  {u.username}
                  {u.inviter && <span className="text-muted"> · invited by {u.inviter}</span>}
                </span>
                <span className="text-xs text-muted">{formatRelative(u.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function Stat({
  label,
  value,
  tone,
  href,
}: {
  label: string
  value: string
  tone?: 'warn' | 'danger'
  href?: string
}) {
  const body = (
    <div className="card p-4">
      <p className="text-sm text-muted">{label}</p>
      <p
        className={`mt-1 text-2xl font-semibold ${
          tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : ''
        }`}
      >
        {value}
      </p>
    </div>
  )
  return href ? (
    <Link href={href} className="transition-opacity hover:opacity-80">
      {body}
    </Link>
  ) : (
    body
  )
}
