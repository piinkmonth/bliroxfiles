import { requireRole } from '@/lib/auth'
import { db } from '@/lib/db'
import { quarantineFile } from '@/lib/moderation'
import { audit } from '@/lib/audit'
import { ok, fail, route, jsonBody } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface ActionBody {
  action?: 'quarantine' | 'dismiss'
  resolution?: string
}

interface ReportRecord {
  id: string
  file_id: string | null
  category: 'csam' | 'malware' | 'copyright' | 'other'
  status: string
}

/**
 * Resolve a report.
 *
 * `quarantine` pulls the file, blocklists its hashes, opens an incident, and
 * (for CSAM) suspends the uploader. `dismiss` closes the report and leaves the
 * file alone. Both are recorded against the moderator who did it.
 */
export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params
  const mod = await requireRole('mod')

  const report = db().prepare(`SELECT * FROM reports WHERE id = ?`).get(id) as
    | ReportRecord
    | undefined
  if (!report) return fail('Report not found', 404)
  if (report.status !== 'open') return fail('That report is already resolved', 409)

  const body = await jsonBody<ActionBody>(req)
  if (!body?.action) return fail('An action is required')

  const now = Date.now()
  let incidentId: string | null = null

  if (body.action === 'quarantine') {
    if (!report.file_id) return fail('That report has no file attached', 400)

    const result = await quarantineFile({
      fileId: report.file_id,
      category: report.category,
      reason: body.resolution || `Actioned from report ${report.id}`,
      actorId: mod.id,
      actorName: mod.username,
      reportId: report.id,
    })
    incidentId = result.incidentId
  } else if (body.action !== 'dismiss') {
    return fail('Unknown action')
  }

  db()
    .prepare(
      `UPDATE reports SET status = ?, resolved_by = ?, resolved_at = ?, resolution = ?
       WHERE id = ?`,
    )
    .run(
      body.action === 'quarantine' ? 'actioned' : 'dismissed',
      mod.id,
      now,
      body.resolution ?? null,
      report.id,
    )

  audit({
    actorId: mod.id,
    actorName: mod.username,
    action: `report.${body.action}`,
    targetType: 'report',
    targetId: report.id,
    detail: { category: report.category, incidentId, resolution: body.resolution },
  })

  return ok({ resolved: true, incidentId })
})
