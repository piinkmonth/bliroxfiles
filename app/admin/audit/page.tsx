import { redirect } from 'next/navigation'
import { currentUser, hasRole } from '@/lib/auth'
import { recentAudit } from '@/lib/audit'
import { formatDate } from '@/lib/format'
import { countryFlag, countryName } from '@/lib/geo'

export const dynamic = 'force-dynamic'

const TONE: Record<string, string> = {
  'file.quarantine': 'text-danger',
  'upload.blocked': 'text-danger',
  'report.quarantine': 'text-danger',
  'user.update': 'text-warn',
  'invite.create': 'text-accent',
  'user.register': 'text-success',
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>
}) {
  const user = await currentUser()
  if (!user || !hasRole(user, 'admin')) redirect('/admin')

  const sp = await searchParams
  const page = Math.max(0, Number(sp.page ?? 0) || 0)
  const pageSize = 100
  const entries = recentAudit(pageSize, page * pageSize)

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        Append-only record of everything that happened. Actor names are stored alongside ids so
        entries stay readable after an account is deleted.
      </p>
      <p className="text-xs text-muted">
        Origin is shown as country only. Addresses are stored encrypted and are not readable from
        this page — they are recoverable solely for a legally compelled disclosure.
      </p>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left text-xs text-muted">
            <tr>
              <th className="p-3 font-medium">When</th>
              <th className="p-3 font-medium">Actor / origin</th>
              <th className="p-3 font-medium">Action</th>
              <th className="p-3 font-medium">Target</th>
              <th className="p-3 font-medium">Detail</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {entries.map((e) => (
              <tr key={e.id}>
                <td className="whitespace-nowrap p-3 text-xs text-muted">
                  {formatDate(e.created_at)}
                </td>
                <td className="p-3">
                  {e.actor_name ?? <span className="text-muted">system</span>}
                  <div className="font-mono text-xs text-muted" title={countryName(e.country)}>
                    {e.country ? `${countryFlag(e.country)} ${e.country}` : '— unknown origin'}
                  </div>
                </td>
                <td className={`whitespace-nowrap p-3 font-mono text-xs ${TONE[e.action] ?? ''}`}>
                  {e.action}
                </td>
                <td className="p-3 font-mono text-xs text-muted">
                  {e.target_type && (
                    <>
                      {e.target_type}
                      <br />
                      {e.target_id}
                    </>
                  )}
                </td>
                <td className="max-w-md p-3">
                  {e.detail && (
                    <code className="block truncate text-xs text-muted" title={e.detail}>
                      {e.detail}
                    </code>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {entries.length === 0 && <p className="p-8 text-center text-muted">Nothing recorded yet.</p>}
      </div>

      <div className="flex justify-between">
        {page > 0 ? (
          <a href={`/admin/audit?page=${page - 1}`} className="btn-ghost">
            Newer
          </a>
        ) : (
          <span />
        )}
        {entries.length === pageSize && (
          <a href={`/admin/audit?page=${page + 1}`} className="btn-ghost">
            Older
          </a>
        )}
      </div>
    </div>
  )
}
