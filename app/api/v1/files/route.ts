import fsp from 'node:fs/promises'
import path from 'node:path'
import { apiRoute, apiOk, apiFail, apiOptions } from '@/lib/apiauth'
import { clientCountry } from '@/lib/auth'
import { db, type FileRow } from '@/lib/db'
import { LIMITS } from '@/lib/config'
import { blobRelPath, blobAbsPath, canAccept, diskHasRoomFor, formatBytes } from '@/lib/storage'
import { getFolder } from '@/lib/folders'
import { sha256File, perceptualHash, isImageMime } from '@/lib/hash'
import { publishBlob } from '@/lib/publish'
import { fileView } from '@/lib/apiviews'
import { newId } from '@/lib/ids'
import {
  parseCreateOptions,
  sanitiseFileName,
  type CreateOptions,
} from '@/lib/filemeta'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 600

const DEFAULT_PAGE = 50
const MAX_PAGE = 200

// ---------------------------------------------------------------------------
// GET /v1/files — list the token owner's files, newest first.
//
// Keyset pagination on (created_at, id): an opaque `cursor` points just past
// the last row of the previous page, so pages stay stable even as new files
// are added. `folder` scopes to a folder id, or "root" for the top level.
// ---------------------------------------------------------------------------

function encodeCursor(row: { created_at: number; id: string }): string {
  return Buffer.from(`${row.created_at}.${row.id}`).toString('base64url')
}

function decodeCursor(raw: string): { createdAt: number; id: string } | null {
  try {
    const [ts, id] = Buffer.from(raw, 'base64url').toString('utf8').split('.')
    const createdAt = Number(ts)
    if (!Number.isFinite(createdAt) || !id) return null
    return { createdAt, id }
  } catch {
    return null
  }
}

export const GET = apiRoute(
  async (req, _ctx, { user }) => {
    const url = new URL(req.url)

    const limit = Math.min(
      MAX_PAGE,
      Math.max(1, Number(url.searchParams.get('limit')) || DEFAULT_PAGE),
    )

    const conditions = [`owner_id = ?`, `status = 'active'`, `deleted_at IS NULL`]
    const params: unknown[] = [user.id]

    const folder = url.searchParams.get('folder')
    if (folder !== null) {
      if (folder === '' || folder === 'root') {
        conditions.push(`folder_id IS NULL`)
      } else {
        conditions.push(`folder_id = ?`)
        params.push(folder)
      }
    }

    const cursorRaw = url.searchParams.get('cursor')
    if (cursorRaw) {
      const cursor = decodeCursor(cursorRaw)
      if (!cursor) return apiFail('Invalid cursor', 400)
      conditions.push(`(created_at < ? OR (created_at = ? AND id < ?))`)
      params.push(cursor.createdAt, cursor.createdAt, cursor.id)
    }

    // Fetch one extra row to learn whether a further page exists.
    const rows = db()
      .prepare(
        `SELECT * FROM files
         WHERE ${conditions.join(' AND ')}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(...params, limit + 1) as FileRow[]

    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows

    return apiOk({
      files: page.map(fileView),
      nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
    })
  },
  { scope: 'read', limit: 'apiRead' },
)

// ---------------------------------------------------------------------------
// POST /v1/files — one-shot upload.
//
// Raw request body with an `X-Filename` header, or a multipart form with a
// `file` field. Options (folder, visibility, note, expiresIn, burnAfter,
// anonymous) ride as query parameters on the raw form and as form fields on
// the multipart form. Capped at LIMITS.apiOneShotBytes — larger files use the
// chunked flow (POST /v1/uploads). Everything funnels through publishBlob, so
// the same blocklist + malware screening the web uploader gets applies here.
// ---------------------------------------------------------------------------

interface ParsedOptions extends CreateOptions {
  folder: string | null
}

/**
 * Parse creation options from a string getter shared by both body forms.
 * The metadata fields are validated by the shared `parseCreateOptions`; only
 * the destination `folder` is specific to the upload route.
 */
function readOptions(
  get: (k: string) => string | null,
): { ok: true; opts: ParsedOptions } | { ok: false; error: string } {
  const parsed = parseCreateOptions({
    visibility: get('visibility'),
    note: get('note'),
    expiresIn: get('expiresIn'),
    burnAfter: get('burnAfter'),
    anonymous: get('anonymous'),
  })
  if (!parsed.ok) return parsed
  return { ok: true, opts: { ...parsed.opts, folder: get('folder') } }
}

/** Stream a request/blob body to disk, refusing to write past `maxBytes`. */
async function streamToFile(
  body: ReadableStream<Uint8Array>,
  absPath: string,
  maxBytes: number,
): Promise<{ ok: true; bytes: number } | { ok: false; status: number; error: string }> {
  await fsp.mkdir(path.dirname(absPath), { recursive: true })
  const handle = await fsp.open(absPath, 'w')
  let written = 0

  try {
    const writer = handle.createWriteStream()
    const reader = body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      written += value.byteLength
      if (written > maxBytes) {
        await reader.cancel()
        throw new Error('over-limit')
      }
      if (!writer.write(value)) {
        await new Promise<void>((resolve) => writer.once('drain', resolve))
      }
    }
    await new Promise<void>((resolve, reject) => {
      writer.end((err?: Error | null) => (err ? reject(err) : resolve()))
    })
  } catch (err) {
    await handle.close().catch(() => {})
    await fsp.rm(absPath, { force: true })
    if (err instanceof Error && err.message === 'over-limit') {
      return {
        ok: false,
        status: 413,
        error: `Body exceeds the ${formatBytes(maxBytes)} one-shot limit — use the chunked upload (POST /v1/uploads) for larger files`,
      }
    }
    return { ok: false, status: 500, error: 'Upload write failed' }
  }

  await handle.close().catch(() => {})
  return { ok: true, bytes: written }
}

export const POST = apiRoute(
  async (req, _ctx, { user }) => {
    const url = new URL(req.url)
    const contentType = req.headers.get('content-type') ?? ''
    const isMultipart = contentType.startsWith('multipart/form-data')

    if (!req.body) return apiFail('Request body is required', 400)

    // Resolve filename, byte source, mime, and options from whichever form.
    let filename: string
    let mime: string | null
    let source: ReadableStream<Uint8Array>
    let options: ReturnType<typeof readOptions>

    if (isMultipart) {
      const form = await req.formData()
      const file = form.get('file')
      if (!(file instanceof Blob)) return apiFail('multipart form needs a "file" field', 400)

      const named = form.get('filename')
      filename = sanitiseFileName(
        (typeof named === 'string' && named) ||
          (file instanceof File ? file.name : '') ||
          req.headers.get('x-filename') ||
          '',
      )
      mime = file.type || null
      source = file.stream()
      options = readOptions((k) => {
        const v = form.get(k)
        return typeof v === 'string' ? v : null
      })
    } else {
      filename = sanitiseFileName(decodeURIComponent(req.headers.get('x-filename') ?? ''))
      // Generic octet-stream carries no information; treat it as unknown.
      const ct = contentType.split(';')[0].trim()
      mime = ct && ct !== 'application/octet-stream' ? ct : null
      source = req.body
      options = readOptions((k) => url.searchParams.get(k))
    }

    if (!filename) return apiFail('A filename is required (X-Filename header or "filename" field)', 400)
    if (!options.ok) return apiFail(options.error, 400)

    // Validate the destination folder up front. The API does not touch
    // encrypted folders — the server cannot screen or read their contents.
    const folderId = options.opts.folder || null
    if (folderId) {
      const folder = getFolder(folderId, user.id)
      if (!folder) return apiFail('Folder not found', 404)
      if (folder.encrypted) {
        return apiFail('The API cannot upload into encrypted folders', 409)
      }
    }

    // A declared Content-Length lets us refuse an oversized upload before
    // reading a single byte; the stream is still hard-capped below regardless.
    const declared = Number(req.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > LIMITS.apiOneShotBytes) {
      return apiFail(
        `Body exceeds the ${formatBytes(LIMITS.apiOneShotBytes)} one-shot limit — use the chunked upload (POST /v1/uploads) for larger files`,
        413,
      )
    }
    if (!diskHasRoomFor(Number.isFinite(declared) ? declared : 0)) {
      return apiFail('The server is low on disk space right now — try again later', 507)
    }

    const fileId = newId()
    const relPath = blobRelPath(fileId)
    const absPath = blobAbsPath(relPath)

    const written = await streamToFile(source, absPath, LIMITS.apiOneShotBytes)
    if (!written.ok) return apiFail(written.error, written.status)
    if (written.bytes === 0) {
      await fsp.rm(absPath, { force: true })
      return apiFail('The uploaded file is empty', 400)
    }

    // Now the real size is known, charge it against quota.
    const quota = canAccept(user.id, written.bytes)
    if (!quota.ok) {
      await fsp.rm(absPath, { force: true })
      return apiFail(quota.reason, 413)
    }

    const sha256 = await sha256File(absPath)
    const phash = isImageMime(mime) ? await perceptualHash(absPath) : null

    const result = await publishBlob({
      user,
      fileId,
      filename,
      mime,
      sha256,
      phash,
      relPath,
      absPath,
      sizeBytes: written.bytes,
      folderId,
      encMeta: null,
      country: await clientCountry(),
      visibility: options.opts.visibility,
      note: options.opts.note,
      expiresAt: options.opts.expiresAt,
      burnAfter: options.opts.burnAfter,
      anonymous: options.opts.anonymous,
    })

    if (!result.ok) return apiFail(result.error, result.status)

    const row = db().prepare(`SELECT * FROM files WHERE id = ?`).get(result.fileId) as FileRow
    return apiOk({ file: fileView(row), duplicate: result.duplicate }, { status: 201 })
  },
  { scope: 'write', limit: 'apiUpload' },
)

export const OPTIONS = apiOptions
