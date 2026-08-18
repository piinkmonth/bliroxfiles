import fsp from 'node:fs/promises'
import path from 'node:path'
import { requireUser } from '@/lib/auth'
import { db } from '@/lib/db'
import { PATHS } from '@/lib/config'
import { audit } from '@/lib/audit'
import { ok, fail, route } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Avatars are re-encoded to this square, so the source resolution is capped. */
const AVATAR_PX = 256
/** Generous for an avatar; anything bigger is either a mistake or an attack. */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024

const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']

/**
 * Confirm the bytes really are one of the formats we accept, by signature
 * rather than by the client's Content-Type (which is just a claim).
 *
 * Defence in depth alongside a patched sharp: a file has to genuinely look
 * like one of five formats before it reaches the image library at all, so
 * malformed input aimed at some other decoder is rejected here first.
 */
function sniffFormat(buf: Buffer): string | null {
  if (buf.length < 12) return null

  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg'
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'png'
  }
  if (buf.subarray(0, 6).toString('ascii') === 'GIF87a') return 'gif'
  if (buf.subarray(0, 6).toString('ascii') === 'GIF89a') return 'gif'
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'webp'
  }
  // ISO-BMFF container: AVIF and HEIF share the ftyp box.
  if (buf.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('ascii')
    if (brand.startsWith('avif') || brand.startsWith('avis') || brand.startsWith('mif1')) {
      return 'avif'
    }
  }
  return null
}

/**
 * Upload a profile picture.
 *
 * The uploaded bytes are never stored or served as-is. sharp decodes and
 * re-encodes to a fixed-size WebP, which normalises the format, strips EXIF
 * (including GPS coordinates people rarely know are in their photos), and
 * discards anything polyglot hiding in the original container.
 */
export const POST = route(async (req: Request) => {
  const user = requireUser()

  const declared = Number(req.headers.get('content-length') ?? '0')
  if (declared > MAX_UPLOAD_BYTES) {
    return fail(`Image must be under ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`, 413)
  }

  const form = await req.formData().catch(() => null)
  const entry = form?.get('avatar')

  // Duck-typed rather than `instanceof File`. The File global exists from Node
  // 20 onward, so this could now be an instanceof check — but duck-typing costs
  // nothing and keeps the route working if it is ever run somewhere older.
  if (!entry || typeof entry === 'string' || typeof entry.arrayBuffer !== 'function') {
    return fail('No image supplied')
  }
  const file = entry as Blob & { name?: string }

  if (file.size > MAX_UPLOAD_BYTES) {
    return fail(`Image must be under ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`, 413)
  }
  if (file.type && !ACCEPTED.includes(file.type)) {
    return fail('Use a JPEG, PNG, WebP, GIF or AVIF image')
  }

  /*
   * sharp's two builds disagree about shape: the ESM one has
   * `export default sharp`, while the CJS one makes `module.exports` the
   * function itself with no `.default` at all. Next resolves the ESM path, but
   * anything that loads this module as CommonJS gets `undefined` from
   * `.default` and fails silently. Accept either.
   *
   * The type comes from `.default` because `typeof import('sharp')` is the
   * namespace, which has no call signature.
   */
  let sharp: typeof import('sharp').default
  try {
    const mod = await import('sharp')
    sharp = (mod.default ?? (mod as unknown)) as typeof import('sharp').default
    if (typeof sharp !== 'function') throw new Error('sharp did not export a function')
  } catch {
    return fail('Image processing is unavailable on this server', 500)
  }

  const input = Buffer.from(await file.arrayBuffer())

  const format = sniffFormat(input)
  if (!format) {
    return fail('That file is not a JPEG, PNG, WebP, GIF or AVIF image')
  }

  let output: Buffer
  try {
    output = await sharp(input, {
      failOn: 'error',
      // ~16 MP. An avatar is 256px square; anything larger is a decompression
      // bomb rather than a profile picture, and this cap is what stops one
      // from allocating gigabytes during decode.
      limitInputPixels: 16_777_216,
      // Refuse multi-frame input outright: only the first frame is ever used,
      // and animated decoding is a materially larger attack surface.
      animated: false,
    })
      .rotate() // honour EXIF orientation before that data is dropped
      .resize(AVATAR_PX, AVATAR_PX, { fit: 'cover', position: 'attention' })
      .webp({ quality: 82 })
      .toBuffer()
  } catch {
    return fail('That file could not be read as an image')
  }

  await fsp.mkdir(PATHS.avatars, { recursive: true, mode: 0o750 })

  const filename = `${user.id}.webp`
  const dest = path.join(PATHS.avatars, filename)
  const tmp = `${dest}.tmp`

  // Write-then-rename so a failure mid-write cannot leave a truncated avatar
  // where a valid one used to be.
  await fsp.writeFile(tmp, output)
  await fsp.rename(tmp, dest)

  const now = Date.now()
  db()
    .prepare(`UPDATE users SET avatar_path = ?, avatar_updated_at = ? WHERE id = ?`)
    .run(filename, now, user.id)

  audit({
    actorId: user.id,
    actorName: user.username,
    action: 'profile.avatar',
    targetType: 'user',
    targetId: user.id,
    detail: { bytes: output.length },
  })

  // The version param busts any cached copy of the previous avatar.
  return ok({ url: `/api/avatar/${user.id}?v=${now}` })
}, { limit: 'avatar' })

export const DELETE = route(async () => {
  const user = requireUser()

  if (user.avatar_path) {
    await fsp.rm(path.join(PATHS.avatars, user.avatar_path), { force: true }).catch(() => {})
  }

  db()
    .prepare(`UPDATE users SET avatar_path = NULL, avatar_updated_at = ? WHERE id = ?`)
    .run(Date.now(), user.id)

  audit({
    actorId: user.id,
    actorName: user.username,
    action: 'profile.avatar_remove',
    targetType: 'user',
    targetId: user.id,
  })

  return ok({ removed: true })
})
