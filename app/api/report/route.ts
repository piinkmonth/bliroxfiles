import { db, type FileRow, type ReportCategory } from '@/lib/db'
import { currentUser, clientIp, clientIpForStorage } from '@/lib/auth'
import { newId } from '@/lib/ids'
import { audit } from '@/lib/audit'
import { ok, fail, route, jsonBody } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface ReportBody {
  slug?: string
  category?: string
  detail?: string
}

const CATEGORIES: ReportCategory[] = ['csam', 'malware', 'copyright', 'other']

export const POST = route(async (req: Request) => {
  const body = await jsonBody<ReportBody>(req)
  if (!body) return fail('Malformed request body')

  // Reports are open to signed-out visitors too — requiring an account to
  // report abuse would defeat the point. Rate limited by IP via route().
  const ip = clientIp()
  const storedIp = clientIpForStorage()

  const category = (body.category ?? 'other') as ReportCategory
  if (!CATEGORIES.includes(category)) return fail('Unknown report category')

  const file = db().prepare(`SELECT * FROM files WHERE slug = ?`).get(body.slug ?? '') as
    | FileRow
    | undefined
  if (!file) return fail('File not found', 404)

  const viewer = currentUser()
  const id = newId()

  db()
    .prepare(
      `INSERT INTO reports (id, file_id, reporter_id, reporter_ip, category, detail, status, priority, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
    )
    .run(
      id,
      file.id,
      viewer?.id ?? null,
      storedIp,
      category,
      (body.detail ?? '').slice(0, 2000),
      // CSAM reports sort above everything else in the queue, always.
      category === 'csam' ? 100 : 10,
      Date.now(),
    )

  audit({
    actorId: viewer?.id ?? null,
    actorName: viewer?.username ?? 'anonymous',
    action: 'report.create',
    targetType: 'file',
    targetId: file.id,
    ip: storedIp,
    detail: { reportId: id, category },
  })

  if (category === 'csam') {
    // Loud, because a queue nobody is watching is not a safety mechanism.
    console.error(
      `[URGENT] CSAM report ${id} filed against file ${file.id} (slug ${file.slug}, ` +
        `uploader ${file.owner_id}). Review at /admin/moderation immediately.`,
    )
  }

  return ok({ reportId: id })
}, { limit: 'report' })
