import fs from 'node:fs'
import { LIMITS } from './config'
import { db } from './db'
import { ipBucket } from './crypto'

/**
 * Egress control.
 *
 * This runs on a home connection. Without a ceiling, two people pulling large
 * files saturate the uplink and everything else on the network — including the
 * tunnel itself — becomes unusable. Downloads are paced and capped in number
 * rather than served at line rate.
 */

let activeDownloads = 0

export function downloadSlotsFree(): number {
  return Math.max(0, LIMITS.maxConcurrentDownloads - activeDownloads)
}

export function tryAcquireSlot(): boolean {
  if (activeDownloads >= LIMITS.maxConcurrentDownloads) return false
  activeDownloads++
  return true
}

export function releaseSlot(): void {
  activeDownloads = Math.max(0, activeDownloads - 1)
}

/**
 * What one download is allowed right now: its share of the total budget, capped
 * by the per-connection ceiling.
 *
 * Evaluated per chunk rather than once at stream start, so a download already
 * running speeds up when others finish and yields when new ones begin. Fixing
 * the rate at the start instead would leave a download that began during a busy
 * moment crawling long after the link went quiet.
 *
 * `activeDownloads` already counts the caller — the route acquires its slot
 * before opening the stream — so the lone-downloader case is budget/1.
 */
function currentRate(perConnectionMax: number): number {
  const active = Math.max(1, activeDownloads)
  return Math.min(perConnectionMax, LIMITS.egressBudgetBytesPerSec / active)
}

/**
 * Read a byte range from a file as a paced ReadableStream.
 *
 * Pacing is a sleep between reads: emit a chunk, then wait however long those
 * bytes were "supposed" to take at the rate currently allowed. Coarse, but it
 * holds the average without needing a real traffic shaper, and it releases the
 * concurrency slot on every exit path including client abort.
 *
 * `bytesPerSec` is a per-connection ceiling, not a fixed rate — see
 * `currentRate` for how it combines with the instance-wide budget.
 */
export function pacedFileStream(opts: {
  absPath: string
  start: number
  end: number
  bytesPerSec?: number
  onBytes?: (n: number) => void
  onDone?: (total: number) => void
}): ReadableStream<Uint8Array> {
  const perConnectionMax = opts.bytesPerSec ?? LIMITS.downloadBytesPerSec
  // Read in 256 KB pieces: small enough that pacing stays smooth, large enough
  // that syscall overhead stays negligible.
  const quantum = 256 * 1024

  const handle = fs.createReadStream(opts.absPath, {
    start: opts.start,
    end: opts.end,
    highWaterMark: quantum,
  })

  let total = 0
  let released = false
  const release = () => {
    if (!released) {
      released = true
      releaseSlot()
      opts.onDone?.(total)
    }
  }

  /*
   * Once the consumer cancels, the controller is closed, and enqueue/close/error
   * on a closed controller throw ERR_INVALID_STATE. That happens routinely: the
   * client closes the tab, or the media player seeks and abandons the range
   * request it had in flight. The handlers below run inside ReadStream listeners
   * rather than a promise, so a throw there is an uncaughtException that takes
   * the process down — not a single failed response.
   *
   * `done` is the guard on every controller touch. The paced resume timer has to
   * be cleared alongside it, or it fires into an already-destroyed stream and
   * keeps the closure alive until it does.
   */
  let done = false
  let resumeTimer: ReturnType<typeof setTimeout> | null = null
  const finish = () => {
    done = true
    if (resumeTimer) {
      clearTimeout(resumeTimer)
      resumeTimer = null
    }
    release()
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      handle.on('data', (raw: string | Buffer) => {
        if (done) return
        // No encoding is set on the stream, so this is always a Buffer.
        const chunk = raw as Buffer
        total += chunk.length
        opts.onBytes?.(chunk.length)
        controller.enqueue(new Uint8Array(chunk))

        // Re-read the allowance every chunk so the rate tracks how many
        // downloads are actually in flight.
        const rate = currentRate(perConnectionMax)
        if (rate > 0) {
          handle.pause()
          resumeTimer = setTimeout(() => {
            resumeTimer = null
            if (!done) handle.resume()
          }, (chunk.length / rate) * 1000)
        }
      })

      handle.on('end', () => {
        if (done) return
        finish()
        controller.close()
      })

      // destroy() can itself emit an error (premature close), which lands here
      // after a cancel — hence the same guard.
      handle.on('error', (err) => {
        if (done) return
        finish()
        controller.error(err)
      })
    },

    cancel() {
      // Client hung up mid-download — stop reading and free the slot. No
      // controller calls here: cancel() is the thing that closed it.
      finish()
      handle.destroy()
    },
  })
}

/**
 * Record served bytes for the admin bandwidth view.
 *
 * The address is stored as its pepper-keyed bucket rather than in the clear.
 * Nothing here ever needs to know *which* address a row belongs to — only
 * whether two rows are the same one, which the bucket answers exactly. That
 * makes the daily cap below work unchanged while leaving no readable address
 * in a table that exists purely for accounting.
 */
export function recordEgress(opts: {
  fileId: string | null
  userId: string | null
  ip: string | null
  bytes: number
}): void {
  if (opts.bytes <= 0) return
  try {
    const day = new Date().toISOString().slice(0, 10)
    db()
      .prepare(
        `INSERT INTO bandwidth_log (day, file_id, user_id, ip, bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(day, opts.fileId, opts.userId, opts.ip ? ipBucket(opts.ip) : null, opts.bytes, Date.now())
  } catch (err) {
    console.error('[egress] failed to record', err)
  }
}

export interface DailyEgress {
  day: string
  bytes: number
}

export function egressByDay(days = 30): DailyEgress[] {
  return db()
    .prepare(
      `SELECT day, SUM(bytes) AS bytes FROM bandwidth_log
       GROUP BY day ORDER BY day DESC LIMIT ?`,
    )
    .all(days) as DailyEgress[]
}

/**
 * Bytes served to one IP today — the input to per-IP abuse limits.
 * A single address pulling hundreds of GB is scraping, not using.
 */
export function egressForIpToday(ip: string): number {
  const day = new Date().toISOString().slice(0, 10)
  const row = db()
    .prepare(`SELECT COALESCE(SUM(bytes), 0) AS n FROM bandwidth_log WHERE ip = ? AND day = ?`)
    .get(ipBucket(ip), day) as { n: number }
  return row.n
}

/** Daily ceiling per IP before downloads are refused. */
export const IP_DAILY_EGRESS_CAP = 60 * 1024 ** 3

/** Parse an HTTP Range header. Only the single-range form is supported. */
export function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | null | 'invalid' {
  if (!header) return null

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return 'invalid'

  const [, startRaw, endRaw] = match

  if (startRaw === '' && endRaw === '') return 'invalid'

  // Suffix form: "bytes=-500" means the final 500 bytes.
  if (startRaw === '') {
    const suffix = Number(endRaw)
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }

  const start = Number(startRaw)
  const end = endRaw === '' ? size - 1 : Number(endRaw)

  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'invalid'
  if (start > end || start >= size) return 'invalid'

  return { start, end: Math.min(end, size - 1) }
}
