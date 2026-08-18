import { redirect } from 'next/navigation'
import { currentUser, hasRole } from '@/lib/auth'
import { db } from '@/lib/db'
import { IncidentsClient } from './IncidentsClient'

export const dynamic = 'force-dynamic'

interface IncidentRow {
  id: string
  category: string
  evidence_json: string
  quarantine_path: string | null
  preserve_until: number | null
  ncmec_status: 'pending' | 'submitted' | 'n/a'
  ncmec_report_id: string | null
  ncmec_notes: string | null
  created_at: number
  submitted_at: number | null
  uploader_name: string | null
}

export default async function IncidentsPage() {
  const user = await currentUser()
  if (!user || !hasRole(user, 'admin')) redirect('/admin')

  const incidents = db()
    .prepare(
      `SELECT i.*, u.username AS uploader_name
       FROM incidents i
       LEFT JOIN users u ON u.id = i.uploader_id
       ORDER BY
         CASE i.ncmec_status WHEN 'pending' THEN 0 ELSE 1 END,
         i.created_at DESC
       LIMIT 200`,
    )
    .all() as IncidentRow[]

  return (
    <IncidentsClient
      incidents={incidents.map((i) => ({
        id: i.id,
        category: i.category,
        evidence: i.evidence_json,
        preserved: !!i.quarantine_path,
        preserveUntil: i.preserve_until,
        ncmecStatus: i.ncmec_status,
        ncmecReportId: i.ncmec_report_id,
        notes: i.ncmec_notes,
        createdAt: i.created_at,
        submittedAt: i.submitted_at,
        uploader: i.uploader_name,
      }))}
    />
  )
}
