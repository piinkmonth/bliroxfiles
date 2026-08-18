import fsp from 'node:fs/promises'
import { apiRoute, apiFail, apiOptions } from '@/lib/apiauth'
import { clientIp } from '@/lib/auth'
import { db, type FileRow, type UserRow } from '@/lib/db'
import { blobAbsPath } from '@/lib/storage'
import {
  pacedFileStream,
  parseRange,
  tryAcquireSlot,
  releaseSlot,
  recordEgress,
  egressForIpToday,
  IP_DAILY_EGRESS_CAP,
} from '@/lib/egress'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 3600

function loadOwned(id: string, user: UserRow): FileRow | null {
  const file = db().prepare(`SELECT * FROM files WHERE id = ?`).get(id) as FileRow | undefined
  if (!file || file.deleted_at || file.owner_id !== user.id) return null
  return file
}

/**
 * GET /v1/files/:id/content — stream a file's bytes to its owner.
 *
 * The bytes are served straight from this origin rather than redirecting to the
 * byte host, because a cross-origin redirect would drop the `Authorization`
 * header and the download would 401. Range is supported, so a client can resume
 * or fetch a slice (fetching a swapfile page, say).
 *
 * This is an owner read, not a public download: it counts served bytes for
 * accounting but deliberately does **not** touch `downloads` or `burn_after`.
 * Spending the burn budget is what a visitor following the share link does; an
 * owner pulling their own bytes back is not that.
 */
export const GET = apiRoute<{ id: string }>(
  async (req, { params }, { user }) => {
    const file = loadOwned(params.id, user)
    if (!file) return apiFail('File not found', 404)

    if (file.status !== 'active') {
      return apiFail('This file is under review and cannot be downloaded', 403)
    }

    // Encrypted blobs are ciphertext the API can never hand back the keys for,
    // so streaming them would only ever yield bytes the caller cannot use.
    if (file.encrypted) {
      return apiFail('Encrypted files cannot be downloaded through the API', 409)
    }

    const ip = await clientIp()
    if (ip && egressForIpToday(ip) > IP_DAILY_EGRESS_CAP) {
      return apiFail('Daily download limit reached for this address', 429)
    }

    const absPath = blobAbsPath(file.storage_path)
    const stat = await fsp.stat(absPath).catch(() => null)
    if (!stat) {
      console.error('[api/content] blob missing for file', file.id, file.storage_path)
      return apiFail('File not found', 404)
    }

    const size = stat.size
    const range = parseRange(req.headers.get('range'), size)

    if (range === 'invalid') {
      return new Response('Range not satisfiable', {
        status: 416,
        headers: { 'Content-Range': `bytes */${size}`, 'Access-Control-Allow-Origin': '*' },
      })
    }

    const start = range ? range.start : 0
    const end = range ? range.end : size - 1
    const length = end - start + 1

    if (!tryAcquireSlot()) {
      return new Response('Server is busy — too many downloads in progress', {
        status: 503,
        headers: { 'Retry-After': '30', 'Access-Control-Allow-Origin': '*' },
      })
    }

    let stream: ReadableStream<Uint8Array>
    try {
      stream = pacedFileStream({
        absPath,
        start,
        end,
        onDone: (total) => {
          db()
            .prepare(`UPDATE files SET bytes_served = bytes_served + ? WHERE id = ?`)
            .run(total, file.id)
          recordEgress({ fileId: file.id, userId: file.owner_id, ip, bytes: total })
        },
      })
    } catch (err) {
      releaseSlot()
      throw err
    }

    const headers = new Headers({
      'Content-Type': file.mime || 'application/octet-stream',
      'Content-Length': String(length),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Access-Control-Allow-Origin': '*',
    })

    if (range) headers.set('Content-Range', `bytes ${start}-${end}/${size}`)

    return new Response(stream, { status: range ? 206 : 200, headers })
  },
  { scope: 'read', limit: 'apiRead' },
)

export const OPTIONS = apiOptions
