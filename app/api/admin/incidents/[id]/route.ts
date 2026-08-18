import { requireRole } from '@/lib/auth'
import { db } from '@/lib/db'
import { PRESERVATION_MS } from '@/lib/moderation'
import { audit } from '@/lib/audit'
import { ok, fail, route, jsonBody } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface PatchBody {
  ncmecStatus?: 'pending' | 'submitted' | 'n/a'
  ncmecReportId?: string
  notes?: string
}

/**
 * Record the outcome of a CyberTipline submission.
 *
 * Marking an incident `submitted` starts the 90-day preservation clock from
 * that moment — 18 U.S.C. § 2258A(h) counts from the report, not from when the
 * content was found. The clock is reset here so the automatic purge cannot
 * remove evidence early.
 */
export const PATCH = route(async (req: Request, { params }: { params: { id: string } }) => {
  const admin = requireRole('admin')

  const incident = db().prepare(`SELECT * FROM incidents WHERE id = ?`).get(params.id) as
    | { id: string; ncmec_status: string; category: string }
    | undefined
  if (!incident) return fail('Incident not found', 404)

  const body = await jsonBody<PatchBody>(req)
  if (!body) return fail('Malformed request body')

  const updates: string[] = []
  const values: unknown[] = []

  if (body.ncmecStatus) {
    if (!['pending', 'submitted', 'n/a'].includes(body.ncmecStatus)) {
      return fail('Unknown NCMEC status')
    }
    updates.push('ncmec_status = ?')
    values.push(body.ncmecStatus)

    if (body.ncmecStatus === 'submitted') {
      updates.push('submitted_at = ?', 'preserve_until = ?')
      values.push(Date.now(), Date.now() + PRESERVATION_MS)
    }
  }

  if (body.ncmecReportId !== undefined) {
    updates.push('ncmec_report_id = ?')
    values.push(body.ncmecReportId.slice(0, 120))
  }

  if (body.notes !== undefined) {
    updates.push('ncmec_notes = ?')
    values.push(body.notes.slice(0, 4000))
  }

  if (updates.length === 0) return fail('Nothing to update')

  values.push(incident.id)
  db().prepare(`UPDATE incidents SET ${updates.join(', ')} WHERE id = ?`).run(...values)

  audit({
    actorId: admin.id,
    actorName: admin.username,
    action: 'incident.update',
    targetType: 'incident',
    targetId: incident.id,
    detail: body,
  })

  return ok({ updated: true })
})
