import fsp from 'node:fs/promises'
import path from 'node:path'
import { db } from '@/lib/db'
import { PATHS } from '@/lib/config'
import { route } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Serve a profile picture.
 *
 * Open to anyone — avatars appear next to files on public share pages, so
 * gating them behind a session would just break those pages. Returns 404
 * rather than a placeholder so the client can fall back to initials.
 */
export const GET = route(async (_req: Request, { params }: { params: { id: string } }) => {
  const row = db()
    .prepare(`SELECT avatar_path, avatar_updated_at FROM users WHERE id = ?`)
    .get(params.id) as { avatar_path: string | null; avatar_updated_at: number | null } | undefined

  if (!row?.avatar_path) return new Response('Not found', { status: 404 })

  // avatar_path is always "<userId>.webp" written by our own upload route, but
  // it still ends up in a filesystem path, so it gets checked like any other.
  const abs = path.resolve(PATHS.avatars, row.avatar_path)
  if (!abs.startsWith(PATHS.avatars + path.sep)) {
    return new Response('Not found', { status: 404 })
  }

  const data = await fsp.readFile(abs).catch(() => null)
  if (!data) return new Response('Not found', { status: 404 })

  return new Response(new Uint8Array(data), {
    headers: {
      'Content-Type': 'image/webp',
      'Content-Length': String(data.length),
      // Safe to cache hard: callers append ?v=<avatar_updated_at>, so a new
      // upload produces a new URL rather than needing revalidation.
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  })
})
