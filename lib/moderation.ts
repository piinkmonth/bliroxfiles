import fsp from 'node:fs/promises'
import { db, type FileRow, type ReportCategory } from './db'
import { blobAbsPath, quarantinePath, recomputeUsage } from './storage'
import { hammingDistance, PHASH_MATCH_THRESHOLD } from './hash'
import { audit } from './audit'
import { newId } from './ids'
import { destroyAllSessions } from './auth'

/**
 * Content preservation window required of a US provider after a CyberTipline
 * report — 18 U.S.C. § 2258A(h). Quarantined material is held, not deleted.
 */
export const PRESERVATION_MS = 90 * 86400_000

export interface BlockMatch {
  id: string
  category: ReportCategory
  reason: string | null
  matchedOn: 'sha256' | 'phash'
  distance?: number
}

/**
 * Check content against the blocklist before it is ever made available.
 *
 * Exact hash first (indexed, instant). Perceptual comparison only runs for
 * images and is a linear scan — fine at blocklist sizes measured in thousands,
 * would need an index structure beyond that.
 */
export function checkBlocklist(sha256: string, phash: string | null): BlockMatch | null {
  const exact = db()
    .prepare(`SELECT id, category, reason FROM blocklist WHERE sha256 = ?`)
    .get(sha256) as { id: string; category: ReportCategory; reason: string | null } | undefined

  if (exact) return { ...exact, matchedOn: 'sha256' }

  if (!phash) return null

  const candidates = db()
    .prepare(`SELECT id, category, reason, phash FROM blocklist WHERE phash IS NOT NULL`)
    .all() as { id: string; category: ReportCategory; reason: string | null; phash: string }[]

  for (const c of candidates) {
    const distance = hammingDistance(phash, c.phash)
    if (distance <= PHASH_MATCH_THRESHOLD) {
      return { id: c.id, category: c.category, reason: c.reason, matchedOn: 'phash', distance }
    }
  }

  return null
}

export function addToBlocklist(opts: {
  sha256?: string | null
  phash?: string | null
  category: ReportCategory
  reason?: string | null
  addedBy?: string | null
}): string {
  const id = newId()
  db()
    .prepare(
      `INSERT INTO blocklist (id, sha256, phash, category, reason, added_by, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       -- idx_blocklist_sha is a PARTIAL index, so the conflict target has to
       -- repeat its WHERE clause verbatim or SQLite refuses to match it and
       -- throws "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE
       -- constraint" at prepare time.
       ON CONFLICT(sha256) WHERE sha256 IS NOT NULL DO NOTHING`,
    )
    .run(id, opts.sha256 ?? null, opts.phash ?? null, opts.category, opts.reason ?? null, opts.addedBy ?? null, Date.now())
  return id
}

/**
 * Take a file out of circulation and open an incident.
 *
 * The blob is *moved*, not deleted:
 *   - it stops being reachable by any download route immediately
 *   - the bytes survive for the preservation window, which is a legal
 *     requirement for CSAM reports and useful evidence for everything else
 *
 * For the CSAM category this also suspends the uploader and kills their
 * sessions, because leaving an account live while its content is under review
 * is how a second upload happens.
 */
export async function quarantineFile(opts: {
  fileId: string
  category: ReportCategory
  reason: string
  actorId: string | null
  actorName: string | null
  reportId?: string | null
  /**
   * Whether to suspend the uploader.
   *
   * Defaults to true for CSAM, which is right when a human moderator has
   * looked at a report and acted. It is deliberately overridable because the
   * automated blocklist path also lands here, and a *perceptual* hash match is
   * a similarity judgement rather than proof — suspending an account on a
   * fuzzy match with nobody in the loop punishes false positives.
   */
  suspendUploader?: boolean
}): Promise<{ incidentId: string }> {
  const file = db().prepare(`SELECT * FROM files WHERE id = ?`).get(opts.fileId) as FileRow | undefined
  if (!file) throw new Error(`No such file: ${opts.fileId}`)

  const incidentId = newId()
  const now = Date.now()
  const suspendUploader = opts.suspendUploader ?? opts.category === 'csam'

  const uploader = db()
    .prepare(`SELECT id, username, email, signup_ip, invited_by, invite_code, created_at FROM users WHERE id = ?`)
    .get(file.owner_id) as Record<string, unknown> | undefined

  // Snapshot everything a report would need, before anything gets deleted.
  const evidence = {
    capturedAt: now,
    file: {
      id: file.id,
      name: file.name,
      size_bytes: file.size_bytes,
      mime: file.mime,
      sha256: file.sha256,
      phash: file.phash,
      slug: file.slug,
      uploaded_at: file.created_at,
      downloads: file.downloads,
    },
    uploader: uploader ?? null,
    inviteChain: uploader ? inviteChain(file.owner_id) : [],
    reason: opts.reason,
    actionedBy: { id: opts.actorId, name: opts.actorName },
  }

  const origin = blobAbsPath(file.storage_path)
  const dest = quarantinePath(incidentId)
  let quarantined: string | null = null
  try {
    await fsp.rename(origin, dest)
    quarantined = dest
  } catch (err) {
    // Blob already gone. Record the incident regardless — the metadata is the
    // part that matters for reporting, and losing it would be worse.
    console.error('[moderation] could not move blob to quarantine', file.id, err)
  }

  const commit = db().transaction(() => {
    db()
      .prepare(`UPDATE files SET status = 'quarantined', deleted_at = ? WHERE id = ?`)
      .run(now, file.id)

    db()
      .prepare(
        `INSERT INTO incidents
           (id, file_id, report_id, uploader_id, category, evidence_json,
            quarantine_path, preserve_until, ncmec_status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        incidentId,
        file.id,
        opts.reportId ?? null,
        file.owner_id,
        opts.category,
        JSON.stringify(evidence, null, 2),
        quarantined,
        now + PRESERVATION_MS,
        opts.category === 'csam' ? 'pending' : 'n/a',
        now,
      )

    // Same content can never be uploaded again, by anyone.
    addToBlocklist({
      sha256: file.sha256,
      phash: file.phash,
      category: opts.category,
      reason: opts.reason,
      addedBy: opts.actorId,
    })

    if (suspendUploader) {
      db()
        .prepare(
          `UPDATE users SET status = 'suspended', suspended_at = ?, suspend_reason = ? WHERE id = ?`,
        )
        .run(now, 'Account suspended pending review of reported content.', file.owner_id)
    }
  })

  try {
    commit()
  } catch (err) {
    // The blob was moved before the transaction ran. Leaving it moved after a
    // rollback gives us a file the database still calls 'active' but which no
    // longer exists on disk — downloads 404 with no record of why. Put it back
    // so the caller can retry against consistent state.
    if (quarantined) {
      await fsp.rename(quarantined, origin).catch((moveBack) => {
        console.error(
          `[moderation] CRITICAL: quarantine of ${file.id} failed AND the blob could not be ` +
            `restored. It is at ${quarantined}, the DB still lists it as active.`,
          moveBack,
        )
      })
    }
    throw err
  }

  if (suspendUploader) destroyAllSessions(file.owner_id)
  recomputeUsage(file.owner_id)

  audit({
    actorId: opts.actorId,
    actorName: opts.actorName,
    action: 'file.quarantine',
    targetType: 'file',
    targetId: file.id,
    detail: { incidentId, category: opts.category, reason: opts.reason, sha256: file.sha256 },
  })

  return { incidentId }
}

/**
 * Walk the invite chain upward from a user.
 *
 * When an account uploads something serious, the first question is who
 * vouched for it — and who vouched for them. Depth-capped against a cycle
 * introduced by a bad admin edit.
 */
export function inviteChain(userId: string, maxDepth = 12): { id: string; username: string }[] {
  const chain: { id: string; username: string }[] = []
  const seen = new Set<string>()
  let cursor: string | null = userId

  while (cursor && chain.length < maxDepth && !seen.has(cursor)) {
    seen.add(cursor)
    const row = db()
      .prepare(`SELECT id, username, invited_by FROM users WHERE id = ?`)
      .get(cursor) as { id: string; username: string; invited_by: string | null } | undefined

    if (!row) break
    chain.push({ id: row.id, username: row.username })
    cursor = row.invited_by
  }

  return chain
}

/** Everyone a user has invited, transitively — the blast radius of a ban. */
export function inviteDescendants(userId: string): { id: string; username: string; depth: number }[] {
  return db()
    .prepare(
      `WITH RECURSIVE tree(id, username, depth) AS (
         SELECT id, username, 1 FROM users WHERE invited_by = ?
         UNION ALL
         SELECT u.id, u.username, tree.depth + 1
         FROM users u JOIN tree ON u.invited_by = tree.id
         WHERE tree.depth < 12
       )
       SELECT * FROM tree ORDER BY depth, username`,
    )
    .all(userId) as { id: string; username: string; depth: number }[]
}

/** Incidents still inside the preservation window. */
export function activePreservations(): { id: string; preserve_until: number; category: string }[] {
  return db()
    .prepare(
      `SELECT id, preserve_until, category FROM incidents
       WHERE preserve_until > ? ORDER BY preserve_until ASC`,
    )
    .all(Date.now()) as { id: string; preserve_until: number; category: string }[]
}

/**
 * Delete quarantined bytes whose preservation window has closed.
 *
 * The incident row and its evidence snapshot are kept forever — only the
 * content itself is removed. Never run this on pending CSAM incidents: the
 * window starts at *submission*, and an unsubmitted report has no clock.
 */
export async function purgeExpiredQuarantine(): Promise<number> {
  const expired = db()
    .prepare(
      `SELECT id, quarantine_path FROM incidents
       WHERE quarantine_path IS NOT NULL
         AND preserve_until < ?
         AND ncmec_status != 'pending'`,
    )
    .all(Date.now()) as { id: string; quarantine_path: string }[]

  let purged = 0
  for (const inc of expired) {
    try {
      await fsp.rm(inc.quarantine_path, { force: true })
      db().prepare(`UPDATE incidents SET quarantine_path = NULL WHERE id = ?`).run(inc.id)
      audit({ action: 'incident.purge', targetType: 'incident', targetId: inc.id })
      purged++
    } catch (err) {
      console.error('[moderation] purge failed', inc.id, err)
    }
  }
  return purged
}
