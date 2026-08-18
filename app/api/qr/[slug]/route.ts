import QRCode from 'qrcode'
import { db, type FileRow } from '@/lib/db'
import { PUBLIC_ORIGIN } from '@/lib/config'
import { route } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * QR code for a share link, as SVG.
 *
 * SVG rather than PNG so it stays sharp when someone enlarges it to point a
 * camera at, and so it costs no image encoding — it is a few hundred bytes of
 * path data generated on the fly.
 *
 * The encoded value is always this server's own share URL, built from
 * PUBLIC_ORIGIN and the slug. Nothing from the request shapes it, so the
 * endpoint cannot be turned into a generator for arbitrary QR codes pointing
 * wherever a caller likes — which is the thing that would make a QR endpoint
 * on a trusted domain worth abusing.
 */
export const GET = route(async (_req: Request, { params }: { params: { slug: string } }) => {
  const file = db()
    .prepare(`SELECT slug, visibility, encrypted, enc_share, status, deleted_at, expires_at
              FROM files WHERE slug = ?`)
    .get(params.slug) as Pick<
    FileRow,
    'slug' | 'visibility' | 'encrypted' | 'enc_share' | 'status' | 'deleted_at' | 'expires_at'
  > | undefined

  if (!file || file.deleted_at || file.status !== 'active') return notFound()
  if (file.expires_at && file.expires_at < Date.now()) return notFound()

  // A QR code is a share link in another shape, so it exists exactly where a
  // shareable link does. Private files have none, and an encrypted file only
  // once its owner has published one.
  if (file.visibility === 'private') return notFound()
  if (file.encrypted && !file.enc_share) return notFound()

  const svg = await QRCode.toString(`${PUBLIC_ORIGIN}/f/${file.slug}`, {
    type: 'svg',
    // Medium correction tolerates a phone camera at an angle without inflating
    // the module count the way high correction does.
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 512,
    // Rendered as currentColor by the client so it follows the page theme;
    // these are the fallback for anyone loading the SVG directly.
    color: { dark: '#000000', light: '#ffffff' },
  })

  return new Response(svg, {
    status: 200,
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      // Generated markup, not uploader content — but an SVG is a document that
      // can carry script, so it is sandboxed like everything else served here.
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  })
})

function notFound() {
  return new Response('Not found', { status: 404 })
}
