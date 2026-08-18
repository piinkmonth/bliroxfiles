import fsp from 'node:fs/promises'
import { db, type UserRow, type UploadSessionRow } from './db'
import { PUBLIC_ORIGIN } from './config'
import { blobRelPath, blobAbsPath, stagingDir, recomputeUsage, formatBytes } from './storage'
import { assembleChunks, markSession, missingChunks } from './uploads'
import { sha256File, perceptualHash, isImageMime } from './hash'
import { checkBlocklist, quarantineFile } from './moderation'
import { scanFile } from './scan'
import { newId, newSlug } from './ids'
import { audit } from './audit'

/**
 * The one place a blob becomes a published file.
 *
 * Blocklist and malware screening MUST run here and nowhere else — every
 * upload path (the web uploader, the API one-shot upload, the API chunked
 * upload) funnels through `publishBlob`, so there is exactly one code path that
 * can turn stored bytes into something reachable at a share URL. Duplicating
 * this logic per entry point is how an unscreened upload route eventually gets
 * written by accident; keeping it single is the security invariant.
 *
 * This file was extracted verbatim from the web complete route. `publishBlob`
 * is deliberately session-agnostic (the API one-shot upload has no session);
 * `finalizeSession` re-adds the chunked-upload lifecycle around it.
 */

export interface PublishInput {
  user: UserRow
  fileId: string
  filename: string
  mime: string | null
  sha256: string
  phash: string | null
  /** Path relative to the blob root, stored in `files.storage_path`. */
  relPath: string
  /** Absolute path where the finished blob already sits on disk. */
  absPath: string
  sizeBytes: number
  folderId: string | null
  /** Non-null marks the upload encrypted → screening is skipped, never shareable. */
  encMeta: string | null
  country: string | null

  // Optional creation fields — supplied by the API, omitted by the web
  // uploader. When omitted, each falls back to the column default, so the web
  // path's stored row is byte-for-byte what it was before the extraction.
  visibility?: 'unlisted' | 'private'
  note?: string | null
  expiresAt?: number | null
  burnAfter?: number | null
  anonymous?: boolean
}

/**
 * Creation options an API caller can set on a chunked upload at completion —
 * the same fields the one-shot upload accepts. The web uploader passes none, so
 * every field falls back to the column default and its published row is
 * unchanged from before this parameter existed.
 */
export type FinalizeOptions = Pick<
  PublishInput,
  'visibility' | 'note' | 'expiresAt' | 'burnAfter' | 'anonymous'
>

export type PublishResult =
  | {
      ok: true
      duplicate: boolean
      fileId: string
      slug: string
      url: string
      name: string
      sizeBytes: number
    }
  | { ok: false; status: number; error: string; extra?: Record<string, unknown> }

/**
 * Screen a finished blob, dedup it, and publish it — or quarantine and refuse.
 *
 * On entry the bytes are already written at `absPath`, hashed, and (for images)
 * perceptually hashed. On a blocked/infected verdict the blob is landed as a
 * row and immediately quarantined (moved out of reach); it is never reachable
 * at its share URL in between. Callers own any staging cleanup.
 */
export async function publishBlob(input: PublishInput): Promise<PublishResult> {
  const {
    user, fileId, filename, mime, sha256, phash, relPath, absPath, sizeBytes, folderId, encMeta, country,
  } = input
  const isEncrypted = !!encMeta

  // ---- Screening -----------------------------------------------------------
  //
  // Encrypted uploads are ciphertext: their hash is of random-looking bytes
  // that change with every re-encryption, so blocklist matching is meaningless
  // rather than merely ineffective. This is the accepted cost of E2E, and the
  // reason such files can never be shared.
  const blocked = isEncrypted ? null : checkBlocklist(sha256, phash)
  if (blocked) {
    // Land the row first so quarantine has something to reference and to
    // preserve — then immediately pull it out of circulation. The file is
    // never reachable at its share URL in between.
    const now = Date.now()
    db()
      .prepare(
        `INSERT INTO files
           (id, owner_id, slug, name, size_bytes, mime, sha256, phash, storage_path,
            visibility, status, created_at, folder_id, encrypted, enc_meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'private', 'active', ?, ?, ?, ?)`,
      )
      .run(
        fileId,
        user.id,
        newSlug(),
        filename,
        sizeBytes,
        mime,
        sha256,
        phash,
        relPath,
        now,
        folderId,
        encMeta ? 1 : 0,
        encMeta,
      )

    // An exact SHA-256 match is proof the bytes are identical to content that
    // was already actioned, so the uploader is suspended. A perceptual match
    // only means "looks similar" — the file is still refused and an incident
    // is opened for review, but no account is closed on a fuzzy signal alone.
    const provenIdentical = blocked.matchedOn === 'sha256'

    await quarantineFile({
      fileId,
      category: blocked.category,
      reason: `Blocked on upload: matched blocklist entry ${blocked.id} via ${blocked.matchedOn}${
        blocked.distance !== undefined ? ` (distance ${blocked.distance})` : ''
      }`,
      actorId: null,
      actorName: 'system',
      suspendUploader: provenIdentical && blocked.category === 'csam',
    })

    audit({
      actorId: user.id,
      actorName: user.username,
      action: 'upload.blocked',
      targetType: 'file',
      targetId: fileId,
      detail: { sha256, matchedOn: blocked.matchedOn, category: blocked.category },
    })

    // Deliberately vague. Confirming *which* signal matched turns the
    // blocklist into an oracle for probing what is already known.
    return { ok: false, status: 403, error: 'This file cannot be uploaded.' }
  }

  // ---- Malware scan --------------------------------------------------------
  //
  // Encrypted uploads are skipped for the same reason blocklist screening is:
  // there is nothing meaningful to scan in ciphertext. A scanner being down
  // does not block the upload — the verdict records that it was unscanned
  // rather than silently implying the file was checked and found clean.
  let scanVerdict: string | null = null
  if (!isEncrypted) {
    const scan = await scanFile({ absPath, sizeBytes, sha256 })
    scanVerdict = scan.verdict === 'clean' ? `clean:${scan.engine ?? 'none'}` : scan.verdict

    if (scan.verdict === 'infected') {
      const now = Date.now()
      db()
        .prepare(
          `INSERT INTO files
             (id, owner_id, slug, name, size_bytes, mime, sha256, phash, storage_path,
              visibility, status, created_at, folder_id, encrypted, enc_meta)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'private', 'active', ?, ?, 0, NULL)`,
        )
        .run(
          fileId, user.id, newSlug(), filename, sizeBytes,
          mime, sha256, phash, relPath, now, folderId,
        )

      // Quarantined, not deleted: the sample is preserved for review, and its
      // hash is blocklisted so nobody can upload it again. The uploader is NOT
      // auto-suspended — people share malware samples for legitimate reasons,
      // and an AV detection alone is not proof of intent to distribute.
      await quarantineFile({
        fileId,
        category: 'malware',
        reason: `${scan.engine} detected ${scan.threat ?? 'malware'}`,
        actorId: null,
        actorName: 'scanner',
        suspendUploader: false,
      })

      audit({
        actorId: user.id,
        actorName: user.username,
        action: 'upload.malware',
        targetType: 'file',
        targetId: fileId,
        detail: { engine: scan.engine, threat: scan.threat, sha256 },
      })

      return {
        ok: false,
        status: 403,
        error: `That file was flagged as malware (${scan.threat ?? 'detection'}) and has not been stored.`,
      }
    }

    if (scan.verdict === 'error') {
      console.error('[upload] scan failed, allowing upload:', scan.detail)
    }
  }

  // ---- Deduplication -------------------------------------------------------
  const existing = db()
    .prepare(
      `SELECT id, slug FROM files
       WHERE owner_id = ? AND sha256 = ? AND status = 'active' AND deleted_at IS NULL`,
    )
    .get(user.id, sha256) as { id: string; slug: string } | undefined

  if (existing) {
    await fsp.rm(absPath, { force: true })
    return {
      ok: true,
      duplicate: true,
      fileId: existing.id,
      slug: existing.slug,
      url: `${PUBLIC_ORIGIN}/f/${existing.slug}`,
      name: filename,
      sizeBytes,
    }
  }

  // ---- Publish -------------------------------------------------------------
  const slug = newSlug()
  const now = Date.now()
  // Encrypted files are private on creation and can never be made shareable —
  // there is no readable content to moderate. Otherwise honour the caller's
  // requested visibility, defaulting to today's 'unlisted'.
  const visibility = isEncrypted ? 'private' : (input.visibility ?? 'unlisted')

  db().transaction(() => {
    db()
      .prepare(
        `INSERT INTO files
           (id, owner_id, slug, name, size_bytes, mime, sha256, phash, storage_path,
            visibility, status, created_at, folder_id, encrypted, enc_meta, country, scan_verdict,
            note, expires_at, burn_after, anonymous)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        fileId,
        user.id,
        slug,
        filename,
        sizeBytes,
        mime,
        sha256,
        phash,
        relPath,
        visibility,
        now,
        folderId,
        isEncrypted ? 1 : 0,
        encMeta,
        country,
        isEncrypted ? 'skipped-encrypted' : (scanVerdict ?? 'unscanned'),
        // Omitted by the web path → NULL/0, i.e. the column defaults.
        input.note ?? null,
        input.expiresAt ?? null,
        input.burnAfter ?? null,
        input.anonymous ? 1 : 0,
      )

    db()
      .prepare(`UPDATE users SET used_bytes = used_bytes + ? WHERE id = ?`)
      .run(sizeBytes, user.id)
  })()

  recomputeUsage(user.id)

  audit({
    actorId: user.id,
    actorName: user.username,
    action: 'upload.complete',
    targetType: 'file',
    targetId: fileId,
    detail: { filename, size: formatBytes(sizeBytes), sha256 },
  })

  return {
    ok: true,
    duplicate: false,
    fileId,
    slug,
    url: `${PUBLIC_ORIGIN}/f/${slug}`,
    name: filename,
    sizeBytes,
  }
}

/**
 * Finalise a chunked upload session: assemble the staged chunks, fingerprint
 * the result, and hand it to `publishBlob`.
 *
 * Screening happens *after* assembly and *before* the file becomes reachable —
 * a hash of a partial file is meaningless, and a file that exists at a share
 * URL before it has been screened is a file that can be distributed.
 *
 * The caller is expected to have already loaded the session and confirmed
 * ownership; this owns everything from status validation onward. Whatever the
 * verdict, the session ends `done` and its staging is removed (only an assembly
 * failure leaves it `failed`).
 */
export async function finalizeSession(
  user: UserRow,
  session: UploadSessionRow,
  options?: FinalizeOptions,
): Promise<PublishResult> {
  if (session.status === 'done') {
    return { ok: false, status: 409, error: 'This upload was already completed' }
  }
  if (session.status === 'assembling') {
    return { ok: false, status: 409, error: 'This upload is already being assembled' }
  }

  const missing = missingChunks(session.received_mask, session.total_chunks)
  if (missing.length > 0) {
    return {
      ok: false,
      status: 409,
      error: `${missing.length} chunk(s) still missing`,
      extra: { missing: missing.slice(0, 200), totalChunks: session.total_chunks },
    }
  }

  markSession(session.id, 'assembling')

  const fileId = newId()
  const relPath = blobRelPath(fileId)
  const absPath = blobAbsPath(relPath)

  let sha256: string
  let phash: string | null = null

  try {
    await assembleChunks(session, absPath)
    sha256 = await sha256File(absPath)
    if (isImageMime(session.mime)) {
      phash = await perceptualHash(absPath)
    }
  } catch (err) {
    markSession(session.id, 'failed')
    await fsp.rm(absPath, { force: true })
    console.error('[upload] assembly failed', session.id, err)
    return { ok: false, status: 500, error: err instanceof Error ? err.message : 'Assembly failed' }
  }

  const result = await publishBlob({
    user,
    fileId,
    filename: session.filename,
    mime: session.mime,
    sha256,
    phash,
    relPath,
    absPath,
    sizeBytes: session.size_bytes,
    folderId: session.folder_id,
    encMeta: session.enc_meta,
    country: session.country,
    // Undefined for the web uploader → column defaults. An encrypted session
    // never carries these, and publishBlob forces encrypted files private
    // regardless, so they only ever take effect on a plain API upload.
    visibility: options?.visibility,
    note: options?.note,
    expiresAt: options?.expiresAt,
    burnAfter: options?.burnAfter,
    anonymous: options?.anonymous,
  })

  // Terminal for the session regardless of verdict: a duplicate, a publish, or
  // a quarantine all mean these chunks are finished with.
  markSession(session.id, 'done')
  await fsp.rm(stagingDir(session.id), { recursive: true, force: true })

  return result
}
