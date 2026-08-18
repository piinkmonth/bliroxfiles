import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { db, type UploadSessionRow } from './db'
import { LIMITS } from './config'
import { chunkPath, stagingDir } from './storage'

// ---------------------------------------------------------------------------
// Chunk bitset
//
// A 15 GB file at 64 MB chunks is 240 chunks = 30 bytes of mask. Tracking
// receipt as a bitset (rather than a count) is what makes resume correct when
// chunks arrive out of order or a retry re-sends one that already landed.
// ---------------------------------------------------------------------------

export function newMask(totalChunks: number): Buffer {
  return Buffer.alloc(Math.ceil(totalChunks / 8), 0)
}

export function maskHas(mask: Buffer, index: number): boolean {
  const byte = index >> 3
  if (byte >= mask.length) return false
  return (mask[byte] & (1 << (index & 7))) !== 0
}

export function maskSet(mask: Buffer, index: number): Buffer {
  const copy = Buffer.from(mask)
  const byte = index >> 3
  if (byte < copy.length) copy[byte] |= 1 << (index & 7)
  return copy
}

export function maskCount(mask: Buffer, totalChunks: number): number {
  let n = 0
  for (let i = 0; i < totalChunks; i++) if (maskHas(mask, i)) n++
  return n
}

/** Indices still outstanding — what the client asks for when resuming. */
export function missingChunks(mask: Buffer, totalChunks: number): number[] {
  const out: number[] = []
  for (let i = 0; i < totalChunks; i++) if (!maskHas(mask, i)) out.push(i)
  return out
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

export function getSession(id: string): UploadSessionRow | null {
  const row = db().prepare(`SELECT * FROM upload_sessions WHERE id = ?`).get(id) as
    | UploadSessionRow
    | undefined
  return row ?? null
}

/** Expected byte length of a given chunk — the last one is a partial. */
export function expectedChunkSize(session: UploadSessionRow, index: number): number {
  if (index < session.total_chunks - 1) return session.chunk_bytes
  const remainder = session.size_bytes % session.chunk_bytes
  return remainder === 0 ? session.chunk_bytes : remainder
}

/**
 * Persist a chunk to staging.
 *
 * Writes to a temp name and renames into place, so a connection that dies
 * mid-write can never leave a short file that later assembles into a corrupt
 * blob. Re-sending an already-received chunk is a no-op, not an error —
 * clients retry, and idempotency is what makes that safe.
 */
export async function writeChunk(
  session: UploadSessionRow,
  index: number,
  body: ReadableStream<Uint8Array>,
): Promise<{ ok: true; alreadyHad: boolean } | { ok: false; error: string }> {
  if (!Number.isInteger(index) || index < 0 || index >= session.total_chunks) {
    return { ok: false, error: `Chunk index out of range (0..${session.total_chunks - 1})` }
  }

  if (maskHas(session.received_mask, index)) {
    return { ok: true, alreadyHad: true }
  }

  const expected = expectedChunkSize(session, index)
  const finalPath = chunkPath(session.id, index)
  const tmpPath = `${finalPath}.tmp`

  await fsp.mkdir(stagingDir(session.id), { recursive: true })

  let written = 0
  const handle = await fsp.open(tmpPath, 'w')
  try {
    const writer = handle.createWriteStream()
    const reader = body.getReader()

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      written += value.byteLength

      // Refuse to buffer past the expected size rather than discovering the
      // overflow after writing it to disk.
      if (written > expected) {
        await reader.cancel()
        throw new Error(`Chunk ${index} is larger than the declared ${expected} bytes`)
      }

      if (!writer.write(value)) {
        await new Promise<void>((resolve) => writer.once('drain', resolve))
      }
    }

    await new Promise<void>((resolve, reject) => {
      writer.end((err?: Error | null) => (err ? reject(err) : resolve()))
    })
  } catch (err) {
    await handle.close().catch(() => {})
    await fsp.rm(tmpPath, { force: true })
    return { ok: false, error: err instanceof Error ? err.message : 'Chunk write failed' }
  }

  await handle.close().catch(() => {})

  if (written !== expected) {
    await fsp.rm(tmpPath, { force: true })
    return { ok: false, error: `Chunk ${index} was ${written} bytes, expected ${expected}` }
  }

  await fsp.rename(tmpPath, finalPath)

  // Re-read the row inside the update: two chunks can land concurrently, and
  // a read-modify-write on a stale mask would silently drop one of them.
  db().transaction(() => {
    const fresh = db()
      .prepare(`SELECT received_mask, total_chunks FROM upload_sessions WHERE id = ?`)
      .get(session.id) as { received_mask: Buffer; total_chunks: number } | undefined
    if (!fresh) return

    const updated = maskSet(fresh.received_mask, index)
    db()
      .prepare(
        `UPDATE upload_sessions
         SET received_mask = ?, received_count = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(updated, maskCount(updated, fresh.total_chunks), Date.now(), session.id)
  })()

  return { ok: true, alreadyHad: false }
}

/**
 * Concatenate staged chunks into a single blob.
 *
 * Streams part-by-part into one destination handle — memory stays flat
 * regardless of file size.
 */
export async function assembleChunks(
  session: UploadSessionRow,
  destAbsPath: string,
  onProgress?: (bytesWritten: number) => void,
): Promise<number> {
  await fsp.mkdir(path.dirname(destAbsPath), { recursive: true })

  const out = fs.createWriteStream(destAbsPath, { flags: 'w' })
  let total = 0

  try {
    for (let i = 0; i < session.total_chunks; i++) {
      const part = chunkPath(session.id, i)
      const stat = await fsp.stat(part)
      const want = expectedChunkSize(session, i)
      if (stat.size !== want) {
        throw new Error(`Chunk ${i} is ${stat.size} bytes on disk, expected ${want}`)
      }

      await new Promise<void>((resolve, reject) => {
        const input = fs.createReadStream(part, { highWaterMark: 4 * 1024 * 1024 })
        input.on('error', reject)
        input.on('data', (buf) => {
          total += buf.length
          onProgress?.(total)
        })
        input.on('end', resolve)
        input.pipe(out, { end: false })
      })
    }
  } catch (err) {
    out.destroy()
    await fsp.rm(destAbsPath, { force: true })
    throw err
  }

  await new Promise<void>((resolve, reject) => {
    out.end((err?: Error | null) => (err ? reject(err) : resolve()))
  })

  if (total !== session.size_bytes) {
    await fsp.rm(destAbsPath, { force: true })
    throw new Error(`Assembled ${total} bytes, expected ${session.size_bytes}`)
  }

  return total
}

export function markSession(id: string, status: UploadSessionRow['status']): void {
  db()
    .prepare(`UPDATE upload_sessions SET status = ?, updated_at = ? WHERE id = ?`)
    .run(status, Date.now(), id)
}

/** Public view of an upload session, safe to hand to the client. */
export function sessionStatus(session: UploadSessionRow) {
  return {
    uploadId: session.id,
    filename: session.filename,
    sizeBytes: session.size_bytes,
    chunkBytes: session.chunk_bytes,
    totalChunks: session.total_chunks,
    receivedChunks: session.received_count,
    missing: missingChunks(session.received_mask, session.total_chunks),
    status: session.status,
    expiresAt: session.expires_at,
  }
}

export function chunkPlan(sizeBytes: number) {
  const chunkBytes = LIMITS.chunkBytes
  return { chunkBytes, totalChunks: Math.max(1, Math.ceil(sizeBytes / chunkBytes)) }
}
