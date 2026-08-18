import fsp from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { requireRole } from '@/lib/auth'
import { PATHS } from '@/lib/config'
import {
  listBackgrounds,
  backgroundUrls,
  getBackgroundMode,
  setBackgroundMode,
  invalidateBackgrounds,
  uploadedBackgroundPath,
} from '@/lib/backgrounds'
import { newId } from '@/lib/ids'
import { audit } from '@/lib/audit'
import { ok, fail, route, jsonBody } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Longest edge a stored background is re-encoded to. 4K covers any display. */
const MAX_EDGE = 3840
/** Generous for a wallpaper; past this it is a mistake or an attack. */
const MAX_UPLOAD_BYTES = 24 * 1024 * 1024

/**
 * Hard floor. Low on purpose.
 *
 * Backgrounds are rendered with CSS `background-size: cover`, so the browser
 * scales whatever it is given to fill the area — there is no size at which an
 * image stops working, only sizes at which it looks soft. The floor therefore
 * exists to catch a favicon or a sprite dropped in by mistake, not to enforce a
 * quality bar the renderer does not actually need.
 *
 * Deliberately *not* solved by upscaling on the way in: enlarging an 800×600
 * photo to 4K invents no detail, it just stores four times the bytes and hands
 * the browser a bigger file to do the same scaling with. Accepting it as-is and
 * saying it may look soft is the honest version.
 */
const MIN_EDGE = 320

/**
 * Below this, the image is likely to look visibly soft on a large display —
 * the split layout shows the photo at close to full strength across roughly
 * half a viewport. Worth mentioning, not worth refusing.
 */
const SOFT_EDGE = 1600

const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp', 'image/avif']

/**
 * Confirm the bytes really are a format we accept, by signature rather than by
 * the client's Content-Type, which is only a claim.
 *
 * Same reasoning as the avatar route: a file has to genuinely look like one of
 * these before it reaches the image library, so malformed input aimed at some
 * other decoder is refused before sharp ever opens it.
 */
function sniffFormat(buf: Buffer): string | null {
  if (buf.length < 12) return null
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg'
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'png'
  }
  if (
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp'
  }
  if (buf.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('ascii')
    if (brand.startsWith('avif') || brand.startsWith('avis') || brand.startsWith('mif1')) {
      return 'avif'
    }
  }
  return null
}

/**
 * Turn an original filename into a safe, readable stored name.
 *
 * The visible part is kept so the admin grid shows something recognisable
 * rather than a row of hex, and a random suffix makes collisions impossible —
 * which in turn means an upload never overwrites an existing background, and
 * the immutable cache header on the serving route is honest.
 */
function storedName(original: string): string {
  const base = path
    .basename(original, path.extname(original))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return `${base || 'background'}-${newId().slice(0, 8)}.webp`
}

export const GET = route(async () => {
  await requireRole('admin')
  // force: an admin opening this page wants the current contents of both
  // directories, not whatever was cached up to 30 seconds ago.
  return ok({ backgrounds: listBackgrounds(true), current: getBackgroundMode() })
})

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/**
 * Add a background.
 *
 * The uploaded bytes are never stored as-is. sharp decodes and re-encodes to
 * WebP, which normalises the format, strips EXIF (including GPS coordinates
 * from a photo taken on a phone), caps the resolution, and discards anything
 * polyglot hiding in the original container.
 *
 * It lands on the storage drive, not in `public/` — see lib/backgrounds.ts for
 * why a file written to `public/` at runtime is listed but never served.
 */
export const POST = route(async (req: Request) => {
  const admin = await requireRole('admin')

  const declared = Number(req.headers.get('content-length') ?? '0')
  if (declared > MAX_UPLOAD_BYTES) {
    return fail(`Image must be under ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`, 413)
  }

  const form = await req.formData().catch(() => null)
  const entry = form?.get('background')

  if (!entry || typeof entry === 'string' || typeof entry.arrayBuffer !== 'function') {
    return fail('No image supplied')
  }
  const file = entry as Blob & { name?: string }

  if (file.size > MAX_UPLOAD_BYTES) {
    return fail(`Image must be under ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`, 413)
  }
  if (file.type && !ACCEPTED.includes(file.type)) {
    return fail('Use a JPEG, PNG, WebP or AVIF image')
  }

  const buf = Buffer.from(await file.arrayBuffer())
  if (!sniffFormat(buf)) {
    return fail('That file is not a JPEG, PNG, WebP or AVIF image')
  }

  let width: number
  let height: number
  let output: Buffer
  try {
    const image = sharp(buf, { limitInputPixels: 100_000_000 })
    const meta = await image.metadata()

    // EXIF orientation swaps what "width" means, so read the dimensions the
    // way they will actually be displayed.
    const rotated = (meta.orientation ?? 1) >= 5
    const w = (rotated ? meta.height : meta.width) ?? 0
    const h = (rotated ? meta.width : meta.height) ?? 0

    if (w < MIN_EDGE || h < MIN_EDGE) {
      // Name the side that actually failed. "That image is 800×600, minimum is
      // 640 on both sides" reads like a bug when 800 clears it and 600 does
      // not — the reader has to work out which number was the problem.
      const side = w < MIN_EDGE ? `width (${w}px)` : `height (${h}px)`
      return fail(
        `That image is ${w}×${h} — its ${side} is below the ${MIN_EDGE}px minimum. ` +
          `That is small enough to be an icon rather than a wallpaper.`,
      )
    }

    output = await image
      .rotate() // apply EXIF orientation before resizing
      .resize(MAX_EDGE, MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer()

    const outMeta = await sharp(output).metadata()
    width = outMeta.width ?? w
    height = outMeta.height ?? h
  } catch (err) {
    console.error('[background] re-encode failed', err)
    return fail('That image could not be processed')
  }

  const name = storedName(file.name ?? 'background')
  await fsp.mkdir(PATHS.backgrounds, { recursive: true, mode: 0o750 })
  await fsp.writeFile(path.join(PATHS.backgrounds, name), output)

  invalidateBackgrounds()

  audit({
    actorId: admin.id,
    actorName: admin.username,
    action: 'settings.background_add',
    detail: { name, width, height, bytes: output.length },
  })

  return ok({
    background: {
      url: `/api/backgrounds/${name}`,
      name,
      source: 'uploaded' as const,
      bytes: output.length,
    },
    // Advisory, not a failure — the upload succeeded either way.
    warning:
      width < SOFT_EDGE || height < SOFT_EDGE
        ? `${name} is ${width}×${height}. It will be scaled up to fill the screen, so it may ` +
          `look soft on a large display. Nothing is wrong with it — a version at ${SOFT_EDGE}px ` +
          `or wider would just look sharper.`
        : null,
    backgrounds: listBackgrounds(true),
  })
}, { limit: 'avatar' })

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Remove a background.
 *
 * Uploaded ones are deleted outright. Built-in ones are refused: they are part
 * of the repository, so deleting one here would be undone by the next deploy
 * and the admin would be left wondering why it came back. Removing those is a
 * git operation, and saying so is more useful than a delete that does not
 * stick.
 */
export const DELETE = route(async (req: Request) => {
  const admin = await requireRole('admin')
  const name = new URL(req.url).searchParams.get('name')
  if (!name) return fail('Which background?')

  const entry = listBackgrounds(true).find((b) => b.name === name)
  if (!entry) return fail('No such background', 404)

  if (entry.source === 'builtin') {
    return fail(
      'That one ships with the site — remove it from public/backgrounds/ in the repo and redeploy.',
      409,
    )
  }

  const abs = uploadedBackgroundPath(name)
  if (!abs) return fail('No such background', 404)

  await fsp.rm(abs, { force: true })
  invalidateBackgrounds()

  // A pinned background that has just been deleted would otherwise leave the
  // site pointing at a URL that 404s. getBackgroundMode falls back to daily on
  // read, but clearing it here keeps the stored value honest.
  const mode = getBackgroundMode()
  if (mode.mode === 'fixed' && !backgroundUrls(true).includes(mode.file)) {
    setBackgroundMode({ mode: 'daily' })
  }

  audit({
    actorId: admin.id,
    actorName: admin.username,
    action: 'settings.background_remove',
    detail: { name },
  })

  return ok({ backgrounds: listBackgrounds(true), current: getBackgroundMode() })
})

// ---------------------------------------------------------------------------
// Mode
// ---------------------------------------------------------------------------

interface Body {
  mode?: 'daily' | 'fixed'
  file?: string
}

export const PUT = route(async (req: Request) => {
  const admin = await requireRole('admin')
  const body = await jsonBody<Body>(req)
  if (!body?.mode) return fail('Pick a mode')

  if (body.mode === 'daily') {
    setBackgroundMode({ mode: 'daily' })
  } else if (body.mode === 'fixed') {
    if (!body.file) return fail('Pick an image')
    // Only URLs this server actually enumerated — never a client-supplied
    // string, which would otherwise be a way to point the CSS at anything.
    if (!backgroundUrls(true).includes(body.file)) {
      return fail('That image is not available', 404)
    }
    setBackgroundMode({ mode: 'fixed', file: body.file })
  } else {
    return fail('Unknown mode')
  }

  audit({
    actorId: admin.id,
    actorName: admin.username,
    action: 'settings.background',
    detail: body,
  })

  return ok({ current: getBackgroundMode() })
})
