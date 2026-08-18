import fs from 'node:fs'
import path from 'node:path'
import { db } from './db'
import { PATHS } from './config'

/**
 * Rotating site backgrounds, from two places.
 *
 * **Built-in**: `public/backgrounds/`, committed with the repo and served by
 * Next's static handler.
 *
 * **Uploaded**: the storage drive, added through the admin panel and served by
 * `/api/backgrounds/[name]`.
 *
 * The split is not arbitrary. Next's static handler resolves `public/` from a
 * manifest built at startup, so an image dropped in there while the server is
 * running gets listed by the scan below but answers 404 when the browser asks
 * for it — a broken thumbnail in the admin grid, or a blank page background if
 * it happens to be the pinned one. It only appears to work in development,
 * where the dev server stats the directory per request.
 *
 * So anything added at runtime goes on the drive instead, which is where the
 * rest of this application's mutable data already lives: it survives a rebuild,
 * it is on the uploads disk rather than the OS one, and it is served by a route
 * that reads from disk when asked.
 */

const BUILTIN_DIR = path.join(process.cwd(), 'public', 'backgrounds')
const IMAGE_EXT = /\.(jpe?g|png|webp|avif)$/i
const RESCAN_MS = 30_000

export type BackgroundSource = 'builtin' | 'uploaded'

export interface Background {
  /** URL the browser loads. Also the stable identifier used everywhere. */
  url: string
  /** Filename, for display and for deletion. */
  name: string
  source: BackgroundSource
  bytes: number
}

let cache: Background[] = []
let scannedAt = 0

function scanDir(dir: string, source: BackgroundSource): Background[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => IMAGE_EXT.test(f))
      .sort()
      .map((name) => {
        let bytes = 0
        try {
          bytes = fs.statSync(path.join(dir, name)).size
        } catch {
          /* raced with a delete; report zero rather than dropping the entry */
        }
        return {
          url: source === 'builtin' ? `/backgrounds/${name}` : `/api/backgrounds/${name}`,
          name,
          source,
          bytes,
        }
      })
  } catch {
    // Directory missing is normal — a fresh install has no uploads yet.
    return []
  }
}

function scan(): Background[] {
  return [...scanDir(BUILTIN_DIR, 'builtin'), ...scanDir(PATHS.backgrounds, 'uploaded')]
}

/**
 * Every available background.
 *
 * Re-scanned on an interval rather than per request: hitting the filesystem for
 * every page load would be wasteful, and thirty seconds is short enough that
 * adding one and refreshing feels immediate. `force` skips the interval, for
 * callers that have just changed the contents themselves.
 */
export function listBackgrounds(force = false): Background[] {
  const now = Date.now()
  if (force || now - scannedAt > RESCAN_MS) {
    cache = scan()
    scannedAt = now
  }
  return cache
}

/** Just the URLs, for callers that only need to pick one. */
export function backgroundUrls(force = false): string[] {
  return listBackgrounds(force).map((b) => b.url)
}

/**
 * Resolve an uploaded background's name to a path on disk.
 *
 * Returns null for anything that escapes the directory or does not exist.
 * The name reaches this from a URL, so it is treated as hostile even though
 * every legitimate one was written by our own upload route.
 */
export function uploadedBackgroundPath(name: string): string | null {
  if (!name || name.includes('/') || name.includes('\\') || name.includes('\0')) return null
  if (!IMAGE_EXT.test(name)) return null

  const abs = path.resolve(PATHS.backgrounds, name)
  if (!abs.startsWith(PATHS.backgrounds + path.sep)) return null
  if (!fs.existsSync(abs)) return null
  return abs
}

/** Drop the cached scan, so the next read reflects a change just made. */
export function invalidateBackgrounds(): void {
  scannedAt = 0
}

// ---------------------------------------------------------------------------
// Admin override
// ---------------------------------------------------------------------------

const SETTING_KEY = 'background_mode'

export type BackgroundMode = { mode: 'daily' } | { mode: 'fixed'; file: string }

export function getBackgroundMode(): BackgroundMode {
  try {
    const row = db().prepare(`SELECT value FROM settings WHERE key = ?`).get(SETTING_KEY) as
      | { value: string }
      | undefined
    if (!row) return { mode: 'daily' }

    const parsed = JSON.parse(row.value) as BackgroundMode
    // A pinned image that has since been deleted must not blank the background.
    if (parsed.mode === 'fixed' && !backgroundUrls().includes(parsed.file)) {
      return { mode: 'daily' }
    }
    return parsed
  } catch {
    return { mode: 'daily' }
  }
}

export function setBackgroundMode(mode: BackgroundMode): void {
  db()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(SETTING_KEY, JSON.stringify(mode), Date.now())
}

// ---------------------------------------------------------------------------

/**
 * The background for today.
 *
 * Deterministic from the date rather than random per request, so the image is
 * stable across every page load within a day and changes once at local
 * midnight. Hashing the date string rather than `dayNumber % length` avoids the
 * lockstep pattern you get when the image count and day counter share a factor.
 */
export function dailyBackground(date = new Date()): string | null {
  const pinned = getBackgroundMode()
  if (pinned.mode === 'fixed') return pinned.file

  const available = backgroundUrls()
  if (available.length === 0) return null

  const key = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
  let hash = 2166136261
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return available[Math.abs(hash) % available.length]
}

/** Retained for callers that genuinely want a fresh pick each time. */
export function randomBackground(): string | null {
  const available = backgroundUrls()
  if (available.length === 0) return null
  return available[Math.floor(Math.random() * available.length)]
}
