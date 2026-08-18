import { db } from '@/lib/db'
import { inviteChain } from '@/lib/moderation'
import { ModerationClient } from './ModerationClient'

export const dynamic = 'force-dynamic'

interface ReportJoin {
  id: string
  category: 'csam' | 'malware' | 'copyright' | 'other'
  detail: string | null
  created_at: number
  reporter_name: string | null
  reporter_ip: string | null
  file_id: string | null
  file_name: string | null
  file_slug: string | null
  file_size: number | null
  file_mime: string | null
  file_sha: string | null
  file_downloads: number | null
  owner_id: string | null
  owner_name: string | null
  owner_status: string | null
}

export default function ModerationPage() {
  const reports = db()
    .prepare(
      `SELECT r.id, r.category, r.detail, r.created_at,
              ru.username     AS reporter_name,
              r.reporter_ip,
              f.id            AS file_id,
              f.name          AS file_name,
              f.slug          AS file_slug,
              f.size_bytes    AS file_size,
              f.mime          AS file_mime,
              f.sha256        AS file_sha,
              f.downloads     AS file_downloads,
              o.id            AS owner_id,
              o.username      AS owner_name,
              o.status        AS owner_status
       FROM reports r
       LEFT JOIN users ru ON ru.id = r.reporter_id
       LEFT JOIN files f  ON f.id  = r.file_id
       LEFT JOIN users o  ON o.id  = f.owner_id
       WHERE r.status = 'open'
       ORDER BY r.priority DESC, r.created_at ASC
       LIMIT 200`,
    )
    .all() as ReportJoin[]

  return (
    <ModerationClient
      reports={reports.map((r) => ({
        id: r.id,
        category: r.category,
        detail: r.detail,
        createdAt: r.created_at,
        reporter: r.reporter_name ?? (r.reporter_ip ? `anonymous (${r.reporter_ip})` : 'anonymous'),
        file: r.file_id
          ? {
              id: r.file_id,
              name: r.file_name ?? '(unknown)',
              slug: r.file_slug ?? '',
              sizeBytes: r.file_size ?? 0,
              mime: r.file_mime,
              sha256: r.file_sha ?? '',
              downloads: r.file_downloads ?? 0,
            }
          : null,
        owner: r.owner_id
          ? {
              id: r.owner_id,
              username: r.owner_name ?? '(unknown)',
              status: r.owner_status ?? 'unknown',
              // Who vouched for this account, all the way up.
              chain: inviteChain(r.owner_id).map((u) => u.username),
            }
          : null,
      }))}
    />
  )
}
