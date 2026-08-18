import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { PATHS, LIMITS } from './config'
import { db } from './db'

// ---------------------------------------------------------------------------
// Blob layout: blobs/ab/cd/<id>  — two levels of sharding keeps any single
// directory well under the point where ext4 htree lookups degrade.
// ---------------------------------------------------------------------------

export function blobRelPath(fileId: string): string {
  return path.join(fileId.slice(0, 2), fileId.slice(2, 4), fileId)
}

export function blobAbsPath(relPath: string): string {
  const abs = path.resolve(PATHS.blobs, relPath)
  // Defence in depth: storage_path comes from our own DB, but a traversal here
  // would read arbitrary files off the host, so it is checked at every use.
  if (abs !== PATHS.blobs && !abs.startsWith(PATHS.blobs + path.sep)) {
    throw new Error(`Refusing path outside blob root: ${relPath}`)
  }
  return abs
}

export function stagingDir(uploadId: string): string {
  if (!/^[a-z0-9]+$/.test(uploadId)) throw new Error('Bad upload id')
  return path.join(PATHS.staging, uploadId)
}

export function chunkPath(uploadId: string, index: number): string {
  if (!Number.isInteger(index) || index < 0) throw new Error('Bad chunk index')
  return path.join(stagingDir(uploadId), `${index}.part`)
}

export function quarantinePath(incidentId: string): string {
  if (!/^[a-z0-9]+$/.test(incidentId)) throw new Error('Bad incident id')
  return path.join(PATHS.quarantine, incidentId)
}

// ---------------------------------------------------------------------------
// Quota
// ---------------------------------------------------------------------------

export interface QuotaState {
  quotaBytes: number
  usedBytes: number
  freeBytes: number
}

export function quotaFor(userId: string): QuotaState {
  const row = db()
    .prepare(`SELECT quota_bytes, used_bytes FROM users WHERE id = ?`)
    .get(userId) as { quota_bytes: number; used_bytes: number } | undefined

  if (!row) throw new Error(`No such user: ${userId}`)
  return {
    quotaBytes: row.quota_bytes,
    usedBytes: row.used_bytes,
    freeBytes: Math.max(0, row.quota_bytes - row.used_bytes),
  }
}

/**
 * Reserve quota for an upload before a single byte is accepted.
 *
 * Counts bytes already committed to files plus bytes promised to other open
 * upload sessions, so three concurrent uploads cannot each individually fit
 * but collectively blow past the allocation.
 */
export function canAccept(userId: string, sizeBytes: number): { ok: true } | { ok: false; reason: string } {
  if (sizeBytes <= 0) return { ok: false, reason: 'File is empty' }
  if (sizeBytes > LIMITS.maxFileBytes) {
    return { ok: false, reason: `Files are capped at ${formatBytes(LIMITS.maxFileBytes)}` }
  }

  const { quotaBytes, usedBytes } = quotaFor(userId)

  const pending = db()
    .prepare(
      `SELECT COALESCE(SUM(size_bytes), 0) AS n FROM upload_sessions
       WHERE owner_id = ? AND status IN ('open', 'assembling') AND expires_at > ?`,
    )
    .get(userId, Date.now()) as { n: number }

  const projected = usedBytes + pending.n + sizeBytes
  if (projected > quotaBytes) {
    const free = Math.max(0, quotaBytes - usedBytes - pending.n)
    return {
      ok: false,
      reason: `Not enough space — ${formatBytes(free)} free of ${formatBytes(quotaBytes)}${
        pending.n > 0 ? ` (${formatBytes(pending.n)} reserved by uploads in progress)` : ''
      }`,
    }
  }

  const open = db()
    .prepare(
      `SELECT COUNT(*) AS n FROM upload_sessions
       WHERE owner_id = ? AND status = 'open' AND expires_at > ?`,
    )
    .get(userId, Date.now()) as { n: number }

  if (open.n >= LIMITS.maxConcurrentUploads) {
    return { ok: false, reason: `Only ${LIMITS.maxConcurrentUploads} uploads at a time` }
  }

  return { ok: true }
}

/**
 * Recompute used_bytes from the files table.
 *
 * Quota is maintained incrementally on upload and delete; this is the repair
 * path for when a crash lands between the file write and the counter update.
 */
export function recomputeUsage(userId: string): number {
  const row = db()
    .prepare(
      `SELECT COALESCE(SUM(size_bytes), 0) AS n FROM files
       WHERE owner_id = ? AND status != 'removed' AND deleted_at IS NULL`,
    )
    .get(userId) as { n: number }

  db().prepare(`UPDATE users SET used_bytes = ? WHERE id = ?`).run(row.n, userId)
  return row.n
}

// ---------------------------------------------------------------------------
// Physical disk
// ---------------------------------------------------------------------------

export interface DiskState {
  totalBytes: number
  freeBytes: number
  usedBytes: number
  /** Sum of every account's allocation — may exceed totalBytes by design. */
  allocatedBytes: number
  overcommitRatio: number
}

export function diskState(): DiskState {
  const stat = fs.statfsSync(PATHS.root)
  const totalBytes = stat.blocks * stat.bsize
  // bavail, not bfree: ext4 reserves ~5% for root that we can never use.
  const freeBytes = stat.bavail * stat.bsize

  const alloc = db()
    .prepare(`SELECT COALESCE(SUM(quota_bytes), 0) AS n FROM users WHERE status != 'banned'`)
    .get() as { n: number }

  return {
    totalBytes,
    freeBytes,
    usedBytes: totalBytes - freeBytes,
    allocatedBytes: alloc.n,
    overcommitRatio: totalBytes > 0 ? alloc.n / totalBytes : 0,
  }
}

/**
 * Headroom guard. Quota is overcommitted, so the real disk can run out while
 * every account still shows space free. Below this margin new uploads are
 * refused and the admin panel shows a red band.
 */
export const DISK_RESERVE_BYTES = 20 * 1024 ** 3

export function diskHasRoomFor(sizeBytes: number): boolean {
  return diskState().freeBytes - sizeBytes > DISK_RESERVE_BYTES
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/** Remove staging directories for expired or finished upload sessions. */
export async function sweepStaging(): Promise<number> {
  const now = Date.now()
  const stale = db()
    .prepare(`SELECT id FROM upload_sessions WHERE expires_at < ? OR status IN ('done', 'failed')`)
    .all(now) as { id: string }[]

  let removed = 0
  for (const { id } of stale) {
    try {
      await fsp.rm(stagingDir(id), { recursive: true, force: true })
      db().prepare(`DELETE FROM upload_sessions WHERE id = ?`).run(id)
      removed++
    } catch {
      // Leave the row in place; the next sweep retries it.
    }
  }

  // Orphaned directories with no session row (crash between mkdir and INSERT).
  try {
    for (const entry of await fsp.readdir(PATHS.staging)) {
      const known = db().prepare(`SELECT 1 FROM upload_sessions WHERE id = ?`).get(entry)
      if (known) continue
      const dir = path.join(PATHS.staging, entry)
      const stat = await fsp.stat(dir).catch(() => null)
      if (stat && now - stat.mtimeMs > LIMITS.stagingTtlMs) {
        await fsp.rm(dir, { recursive: true, force: true })
        removed++
      }
    }
  } catch {
    // Staging dir may not exist yet.
  }

  return removed
}

// ---------------------------------------------------------------------------

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

export function formatBytes(bytes: number, decimals = 1): string {
  if (bytes === 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1)
  const value = bytes / 1024 ** i
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : decimals)} ${UNITS[i]}`
}
