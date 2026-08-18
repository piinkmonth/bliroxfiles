import { apiRoute, apiOk, apiFail, apiOptions } from '@/lib/apiauth'
import { db, type FileRow } from '@/lib/db'
import { getSession } from '@/lib/uploads'
import { finalizeSession, type FinalizeOptions } from '@/lib/publish'
import { parseCreateOptions } from '@/lib/filemeta'
import { fileView } from '@/lib/apiviews'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 3600

/**
 * POST /v1/uploads/:id/complete — assemble, screen, and publish a session.
 *
 * The work — and the blocklist + malware screening invariant — lives in
 * `finalizeSession` (lib/publish.ts), shared with the web uploader so a single
 * code path owns screening. An optional JSON body sets the same creation
 * options the one-shot upload accepts (visibility, note, expiresIn/expiresAt,
 * burnAfter, anonymous); with no body the file takes the defaults.
 */
export const POST = apiRoute<{ id: string }>(
  async (req, { params }, { user }) => {
    const session = getSession(params.id)
    if (!session) return apiFail('Upload session not found — it may have expired', 404)
    if (session.owner_id !== user.id) return apiFail('Upload session not found', 404)

    // The options body is optional. Only a body that is present *and* malformed
    // is an error; an absent one just means "publish with defaults".
    let options: FinalizeOptions | undefined
    const raw = (await req.text()).trim()
    if (raw) {
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        return apiFail('Malformed JSON body', 400)
      }
      const obj = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
      const validated = parseCreateOptions(obj)
      if (!validated.ok) return apiFail(validated.error, 400)
      options = validated.opts
    }

    const result = await finalizeSession(user, session, options)
    if (!result.ok) return apiFail(result.error, result.status, result.extra)

    const row = db().prepare(`SELECT * FROM files WHERE id = ?`).get(result.fileId) as FileRow
    return apiOk({ file: fileView(row), duplicate: result.duplicate }, { status: 201 })
  },
  { scope: 'write', limit: 'apiUpload' },
)

export const OPTIONS = apiOptions
