import fsp from 'node:fs/promises'
import { db, type FileRow } from '@/lib/db'
import { blobAbsPath, recomputeUsage } from '@/lib/storage'
import { deleteThumb } from '@/lib/preview'
import { audit } from '@/lib/audit'
import { clientIp, currentUser } from '@/lib/auth'
import { fileAccess } from '@/lib/collab'
import { cookies } from 'next/headers'
import { unlockCookieName } from '@/lib/share'
import {
  pacedFileStream,
  parseRange,
  tryAcquireSlot,
  releaseSlot,
  recordEgress,
  egressForIpToday,
  IP_DAILY_EGRESS_CAP,
} from '@/lib/egress'
import { allowedOrigin } from '@/lib/csrf'
import { fail, route } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 3600

interface Params {
  params: Promise<{ slug: string }>
}

// serve file bytes. reachable via the cdn/us01 hostnames + the app host — the
// hostname's cosmetic today, but keeping bytes on their own names means we can
// point them at other infra later without breaking share links already out
export const GET = route(async (req: Request, { params }: Params) => {
  // cors, for the encrypted-file page.
  // most callers here are <img>/<video>/plain navigation, none of which need
  // cors. the encrypted share page is different: it has to fetch() the ciphertext
  // to decrypt in the browser, and the page's on the app host while the bytes
  // come off the byte host. same site, different origin, so the browser needs the
  // response to say it can be read.
  // set on error responses too — else a 404/410 from here shows up in the page as
  // an opaque "failed to fetch", which is way worse to show someone than "this
  // link's been used up".
  const cors = corsHeaders(req)
  const { slug } = await params

  const file = db()
    .prepare(`SELECT * FROM files WHERE slug = ?`)
    .get(slug) as FileRow | undefined

  if (!file) return fail('File not found', 404, undefined, cors)

  // check burned BEFORE the generic gone check below, bc a burned file IS gone
  // (status 'removed', deleted_at set) and would otherwise answer 404 — which
  // reads as "you mistyped the link". the link was real and worked, its just
  // spent. saying so is the difference between someone re-checking the url vs
  // asking the sender for a new one.
  if (file.burned_at || (file.burn_after !== null && file.burn_after <= 0)) {
    return fail('This link has already been used up', 410, undefined, cors)
  }

  if (file.deleted_at || file.status !== 'active') {
    return fail('File not found', 404, undefined, cors)
  }

  if (file.expires_at && file.expires_at < Date.now()) {
    return fail('This link has expired', 410, undefined, cors)
  }

  // who's allowed these bytes.
  // isOwner stays strictly the owner bc it also gates the password exemption
  // below, and being a folder collaborator isnt grounds to skip a per-file
  // password. access is the broader "can this person see the file at all" —
  // owner, or someone the folder got shared with.
  const viewer = await currentUser()
  const isOwner = !!viewer && viewer.id === file.owner_id
  const access = viewer ? fileAccess(file, viewer.id) : null

  if (file.visibility === 'private' && !access) {
    return fail('File not found', 404, undefined, cors)
  }

  // encrypted files are ciphertext, so handing them to a stranger leaks nothing
  // readable — but the link still had to be deliberately shared. no enc_share and
  // the only people who get the bytes are the owner + the folder's collaborators.
  if (file.encrypted && !file.enc_share && !access) {
    return fail('File not found', 404, undefined, cors)
  }

  // password-protected link needs the unlock cookie from /unlock. owner's exempt
  // — getting asked for a password on your own file is absurd.
  if (file.password_hash && !isOwner) {
    if ((await cookies()).get(unlockCookieName(file.id))?.value !== '1') {
      return fail('This file is password protected', 401, undefined, cors)
    }
  }

  const ip = await clientIp()

  if (ip && egressForIpToday(ip) > IP_DAILY_EGRESS_CAP) {
    return fail('Daily download limit reached for this address', 429, undefined, cors)
  }

  const absPath = blobAbsPath(file.storage_path)
  const stat = await fsp.stat(absPath).catch(() => null)
  if (!stat) {
    console.error('[dl] blob missing for file', file.id, file.storage_path)
    return fail('File not found', 404, undefined, cors)
  }

  // ?inline=1 renders in place instead of downloading, for previews. honoured
  // only for types on the allowlist below — never svg, html or pdf.
  const wantsInline = new URL(req.url).searchParams.get('inline') === '1'
  const inline = wantsInline && INLINE_SAFE.has((file.mime ?? '').toLowerCase())

  const size = stat.size
  const range = parseRange(req.headers.get('range'), size)

  if (range === 'invalid') {
    return new Response('Range not satisfiable', {
      status: 416,
      headers: { 'Content-Range': `bytes */${size}`, ...cors },
    })
  }

  const start = range ? range.start : 0
  const end = range ? range.end : size - 1
  const length = end - start + 1

  if (!tryAcquireSlot()) {
    return new Response('Server is busy — too many downloads in progress', {
      status: 503,
      headers: { 'Retry-After': '30', ...cors },
    })
  }

  // count the download once per fresh request, not once per range request, or a
  // resumed download inflates the counter into nonsense.
  // an inline request is a preview — a player on the file page, or a link
  // unfurler. counting those means the number climbs every time someone just
  // *looks at* the page, and a seeking video player adds one per seek. bytes
  // served still get recorded — previewing costs real bandwidth even if its not
  // a download.
  const counts = (!range || start === 0) && !inline
  let burnNow = false

  if (counts) {
    // claim a download slot: check the budget and spend it in one statement.
    // the budget test lives in the WHERE clause on purpose. reading burn_after at
    // the top and comparing here leaves a window where a dozen simultaneous
    // requests all read the same healthy number and all proceed — which is
    // exactly what happened, a budget of three served eight. SQLite serialises
    // writers, so as a WHERE clause it matches for precisely as many requests as
    // theres budget for, no more.
    // a request that matches nothing didnt get a slot. refused, not served, even
    // though the row + bytes still exist — the budget is the promise we keep here.
    const claimed = db()
      .prepare(
        `UPDATE files
            SET downloads = downloads + 1,
                burn_after = CASE WHEN burn_after IS NULL THEN NULL
                                  ELSE burn_after - 1 END
          WHERE id = ?
            AND burned_at IS NULL
            AND (burn_after IS NULL OR burn_after > 0)
          RETURNING burn_after`,
      )
      .get(file.id) as { burn_after: number | null } | undefined

    if (!claimed) {
      releaseSlot()
      return fail('This link has already been used up', 410, undefined, cors)
    }

    // this request took the last slot. serve it, then destroy the file.
    if (claimed.burn_after !== null && claimed.burn_after <= 0) burnNow = true
  }

  let stream: ReadableStream<Uint8Array>
  try {
    stream = pacedFileStream({
      absPath,
      start,
      end,
      onDone: (total) => {
        db().prepare(`UPDATE files SET bytes_served = bytes_served + ? WHERE id = ?`).run(total, file.id)
        recordEgress({ fileId: file.id, userId: file.owner_id, ip, bytes: total })
        // destroy only once the bytes are actually out the door. burning at
        // request time would lose the file to a download that then failed
        // halfway — the worst possible moment to have destroyed it.
        if (burnNow) void burnFile(file)
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
    'Content-Disposition': contentDisposition(file.name, inline),
    // never let an intermediary cache user content — cloudflare especially
    // shouldnt be storing these.
    'Cache-Control': 'private, no-store',
    // served off a hostname that shares a registrable domain with the app, so it
    // must never be able to run as the app.
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    ...cors,
  })

  if (range) {
    headers.set('Content-Range', `bytes ${start}-${end}/${size}`)
  }

  return new Response(stream, { status: range ? 206 : 200, headers })
})

// preflight.
// a plain GET with no custom headers isnt preflighted, so nothing hits this
// today. it exists so that adding a header to a client fetch later — Range, most
// likely, which isnt on the cors safelist — fails visibly on a missing allowance
// instead of mysteriously on a missing handler.
export const OPTIONS = route(async (req: Request) => {
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(req),
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Range, Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  })
})

// cors headers for a request, or nothing when the caller isnt one of ours.
// returning {} instead of a wildcard for an unknown origin is the point: an
// unrecognised site gets no allowance and the browser wont let it read the
// response, while same-origin callers (the vast majority) dont care either way.
function corsHeaders(req: Request): Record<string, string> {
  const origin = allowedOrigin(req.headers.get('origin'))
  if (!origin) return {}

  return {
    'Access-Control-Allow-Origin': origin,
    // session cookie has to travel so an owner can fetch their own encrypted
    // file before theyve published a link for it.
    'Access-Control-Allow-Credentials': 'true',
    // body varies by whether the caller was allowed, so any cache in between must
    // key on it.
    Vary: 'Origin',
  }
}

// destroy a file whose download budget ran out.
// blob goes, row gets soft-deleted, uploader gets their quota back — same path an
// explicit delete takes, so quota accounting + the moderation trail behave the
// same whether a file was burned or removed by hand. the row surviving is what
// lets a later visitor be told the link was used up rather than that it never
// existed.
async function burnFile(file: FileRow): Promise<void> {
  try {
    await fsp.rm(blobAbsPath(file.storage_path), { force: true })
    await deleteThumb(file)

    db()
      .prepare(
        `UPDATE files SET status = 'removed', deleted_at = ?, burned_at = ? WHERE id = ?`,
      )
      .run(Date.now(), Date.now(), file.id)

    recomputeUsage(file.owner_id)

    audit({
      actorId: null,
      actorName: 'system',
      action: 'file.burned',
      targetType: 'file',
      targetId: file.id,
      detail: { name: file.name, downloads: file.downloads + 1 },
    })
  } catch (err) {
    console.error('[dl] burn failed for', file.id, err)
  }
}

// rfc 6266 content-disposition with both the ascii fallback + the utf-8 form, so
// non-latin filenames survive the round trip.
function contentDisposition(name: string, inline: boolean): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  const encoded = encodeURIComponent(name)
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

// types we'll render inline instead of forcing a download.
// strict allowlist of raster formats + nothing else. deliberately missing:
//  - svg — its a document that can carry <script> and would run with the origin
//    of whatever host serves it.
//  - html — same reason, only more obvious.
//  - pdf — viewers have a long history of being an execution surface.
// anything not on this list is served as an attachment no matter what the request
// asks, so ?inline=1 can never turn an upload into a page running on the cdn host.
const INLINE_SAFE = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/mp4',
])
