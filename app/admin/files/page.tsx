import { db } from '@/lib/db'
import { FilesAdminClient } from './FilesAdminClient'

export const dynamic = 'force-dynamic'

interface Row {
  id: string
  slug: string
  name: string
  size_bytes: number
  mime: string | null
  sha256: string
  status: string
  created_at: number
  country: string | null
  encrypted: number
  verified_at: number | null
  verified_note: string | null
  scan_verdict: string | null
  downloads: number
  owner_name: string | null
  verifier_name: string | null
}

export default async function AdminFilesPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; q?: string }>
}) {
  const sp = await searchParams
  const view = sp.view === 'quarantined' ? 'quarantined' : 'active'
  const q = (sp.q ?? '').trim()

  const rows = db()
    .prepare(
      `SELECT f.id, f.slug, f.name, f.size_bytes, f.mime, f.sha256, f.status,
              f.created_at, f.country, f.encrypted, f.verified_at, f.verified_note,
              f.scan_verdict, f.downloads,
              o.username AS owner_name,
              v.username AS verifier_name
       FROM files f
       LEFT JOIN users o ON o.id = f.owner_id
       LEFT JOIN users v ON v.id = f.verified_by
       WHERE f.status = ?
         AND (? = '' OR f.name LIKE '%' || ? || '%' OR o.username LIKE '%' || ? || '%')
       ORDER BY f.created_at DESC
       LIMIT 300`,
    )
    .all(view === 'quarantined' ? 'quarantined' : 'active', q, q, q) as Row[]

  const counts = db()
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM files WHERE status = 'active')      AS active,
         (SELECT COUNT(*) FROM files WHERE status = 'quarantined') AS quarantined`,
    )
    .get() as { active: number; quarantined: number }

  return (
    <FilesAdminClient
      view={view}
      query={q}
      counts={counts}
      files={rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        sizeBytes: r.size_bytes,
        mime: r.mime,
        sha256: r.sha256,
        createdAt: r.created_at,
        country: r.country,
        encrypted: !!r.encrypted,
        verified: !!r.verified_at,
        verifiedNote: r.verified_note,
        verifiedBy: r.verifier_name,
        scanVerdict: r.scan_verdict,
        downloads: r.downloads,
        owner: r.owner_name ?? '(deleted)',
      }))}
    />
  )
}
