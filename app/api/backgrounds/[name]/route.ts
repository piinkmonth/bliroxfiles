import fsp from 'node:fs/promises'
import { uploadedBackgroundPath } from '@/lib/backgrounds'
import { route } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Serve an uploaded site background.
 *
 * Open to anyone, deliberately: backgrounds appear on the login page and on
 * public share pages, so gating them behind a session would leave exactly the
 * pages most people see with no background at all.
 *
 * This route existing is the point of storing uploads on the drive rather than
 * in `public/` — Next resolves `public/` from a manifest built at startup, so
 * an image written there while the server runs is never served. Reading from
 * disk on request is what lets a background appear the moment it is uploaded.
 */
export const GET = route(async (_req: Request, { params }: { params: Promise<{ name: string }> }) => {
  const { name } = await params
  // Comes in from the URL, so it is validated as a path even though every
  // legitimate name here was written by our own upload route.
  const abs = uploadedBackgroundPath(decodeURIComponent(name))
  if (!abs) return new Response('Not found', { status: 404 })

  const data = await fsp.readFile(abs).catch(() => null)
  if (!data) return new Response('Not found', { status: 404 })

  return new Response(new Uint8Array(data), {
    headers: {
      // Uploads are re-encoded to WebP, so the type is known rather than sniffed.
      'Content-Type': 'image/webp',
      'Content-Length': String(data.length),
      /*
       * A background's filename carries a random suffix and is never rewritten
       * in place — replacing one produces a different name — so the bytes at
       * this URL cannot change and it is safe to cache hard. Deleting one makes
       * the URL 404 rather than serve something else.
       */
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  })
})
