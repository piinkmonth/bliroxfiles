import fsp from 'node:fs/promises'
import { requireUser, clientIpForStorage } from '@/lib/auth'
import { db, type FileRow } from '@/lib/db'
import { blobAbsPath } from '@/lib/storage'
import { tryAcquireSlot, releaseSlot, recordEgress } from '@/lib/egress'
import { audit } from '@/lib/audit'
import { fail, route, jsonBody } from '@/lib/api'
import { zipStream } from '@/lib/zip'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 3600

/**
 * 4 GiB is a hard limit of the ZIP format without ZIP64 — offsets and sizes in
 * the central directory are 32-bit. Sitting a little under it leaves room for
 * headers. Larger files are downloaded individually, which streams fine.
 */
const MAX_ZIP_BYTES = 3.9 * 1024 ** 3
const MAX_FILES = 200

/**
 * Bundle several of the caller's own files into a ZIP.
 *
 * Owner-only and POST-only: this exists for "select a few things in the
 * dashboard and get them as one download", not as a share mechanism. Sharing
 * stays one link per file, where reporting and moderation can reach it.
 *
 * Encrypted files are excluded — the server holds only ciphertext, so what
 * ended up in the archive would be undecryptable noise.
 */
export const POST = route(async (req: Request) => {
  const user = requireUser()

  /*
   * Accepts both JSON and a form post. The dashboard submits a real <form> so
   * the browser saves the streamed archive directly — fetching it would mean
   * buffering gigabytes into a Blob purely to trigger a download.
   */
  let raw: unknown[] = []
  const contentType = req.headers.get('content-type') ?? ''

  if (contentType.includes('application/json')) {
    raw = (await jsonBody<{ ids?: unknown[] }>(req))?.ids ?? []
  } else {
    const form = await req.formData().catch(() => null)
    const field = form?.get('ids')
    if (typeof field === 'string') {
      try {
        const parsed = JSON.parse(field)
        if (Array.isArray(parsed)) raw = parsed
      } catch {
        return fail('Malformed selection')
      }
    }
  }

  const ids = raw.filter((id): id is string => typeof id === 'string').slice(0, MAX_FILES)
  if (ids.length === 0) return fail('Pick at least one file')

  const placeholders = ids.map(() => '?').join(',')
  const files = db()
    .prepare(
      `SELECT * FROM files
       WHERE id IN (${placeholders}) AND owner_id = ?
         AND status = 'active' AND deleted_at IS NULL AND encrypted = 0`,
    )
    .all(...ids, user.id) as FileRow[]

  if (files.length === 0) return fail('None of those files are available to zip', 404)

  const total = files.reduce((n, f) => n + f.size_bytes, 0)
  if (total > MAX_ZIP_BYTES) {
    return fail(
      `That selection is ${(total / 1024 ** 3).toFixed(1)} GB — archives are capped at ` +
        `3.9 GB. Download the large ones individually, or zip fewer at a time.`,
      413,
    )
  }

  // Confirm every blob exists before committing to a response; a missing one
  // partway through would truncate the archive with no way to signal an error.
  const entries: { name: string; path: string; size: number }[] = []
  const used = new Set<string>()

  for (const file of files) {
    const path = blobAbsPath(file.storage_path)
    const stat = await fsp.stat(path).catch(() => null)
    if (!stat) {
      console.error('[zip] blob missing', file.id)
      continue
    }
    entries.push({ name: uniqueName(file.name, used), path, size: stat.size })
  }

  if (entries.length === 0) return fail('None of those files could be read', 404)

  if (!tryAcquireSlot()) {
    return new Response('Server is busy — too many downloads in progress', {
      status: 503,
      headers: { 'Retry-After': '30' },
    })
  }

  audit({
    actorId: user.id,
    actorName: user.username,
    action: 'file.zip',
    ip: clientIpForStorage(),
    detail: { count: entries.length, bytes: total },
  })

  const stream = zipStream(entries, {
    onDone: (bytes) => {
      releaseSlot()
      recordEgress({ fileId: null, userId: user.id, ip: null, bytes })
    },
    onError: () => releaseSlot(),
  })

  const stamp = new Date().toISOString().slice(0, 10)
  return new Response(stream, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="blirox-${stamp}.zip"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
})

/** Two files can share a name across folders; ZIP entries cannot. */
function uniqueName(name: string, used: Set<string>): string {
  // eslint-disable-next-line no-control-regex
  const clean = name.replace(/[\x00-\x1f\x7f]/g, '').replace(/[/\\]/g, '_') || 'file'
  if (!used.has(clean)) {
    used.add(clean)
    return clean
  }

  const dot = clean.lastIndexOf('.')
  const stem = dot > 0 ? clean.slice(0, dot) : clean
  const ext = dot > 0 ? clean.slice(dot) : ''

  for (let i = 2; ; i++) {
    const candidate = `${stem} (${i})${ext}`
    if (!used.has(candidate)) {
      used.add(candidate)
      return candidate
    }
  }
}

