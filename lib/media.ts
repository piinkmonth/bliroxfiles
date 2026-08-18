import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Video dimensions and poster frames.
 *
 * A link unfurler needs to know how big a video is before it can lay out a
 * player for it — without `og:video:width` and `og:video:height`, Discord
 * degrades the embed to a plain link. So the dimensions have to come from
 * somewhere, and there are two ways to get them:
 *
 *  1. **ffprobe**, when it happens to be installed. Handles every container,
 *     and its sibling ffmpeg can pull a still for the poster image.
 *
 *  2. **Reading the MP4 container directly**, which needs nothing installed.
 *     MP4 stores display dimensions in a fixed place and is what the
 *     overwhelming majority of shared video is, so this covers the common case
 *     on a server with no extra packages.
 *
 * ffmpeg is deliberately optional, matching how lib/scan.ts treats ClamAV: it
 * is used when present and its absence is reported honestly rather than
 * silently pretending the work was done. Without it, embeds still size
 * correctly — they just have no poster still.
 */

export interface VideoInfo {
  width: number | null
  height: number | null
  /** Seconds. Only ffprobe supplies this reliably. */
  duration: number | null
}

// ---------------------------------------------------------------------------
// ffmpeg / ffprobe availability
// ---------------------------------------------------------------------------

let ffmpegChecked = false
let ffmpegPresent = false

/**
 * Whether ffmpeg is usable, resolved once per process.
 *
 * Probing the binary on every upload would fork a process just to be told the
 * same thing, and the answer cannot change without a restart of the machine's
 * package set — at which point restarting the app is reasonable to ask.
 */
export async function ffmpegAvailable(): Promise<boolean> {
  if (ffmpegChecked) return ffmpegPresent
  ffmpegChecked = true
  try {
    await run('ffprobe', ['-version'], { timeout: 5_000 })
    ffmpegPresent = true
  } catch {
    ffmpegPresent = false
    console.log('[media] ffmpeg not found — video posters disabled, dimensions from MP4 parsing')
  }
  return ffmpegPresent
}

// ---------------------------------------------------------------------------
// MP4 container parsing
// ---------------------------------------------------------------------------

/**
 * Pull display dimensions out of an MP4/MOV `tkhd` box.
 *
 * The layout being walked: `moov` → `trak` → `tkhd`, where tkhd ends with a
 * 3x3 transformation matrix and then width and height as 16.16 fixed-point.
 *
 * Two details that are easy to get wrong and produce sideways videos:
 *
 * - A file has several tracks and only one of them is video. Audio tracks
 *   carry zero dimensions, so the first track with non-zero width wins.
 *
 * - Phones record in landscape and store a rotation in the matrix rather than
 *   rotating the pixels. A 90° or 270° rotation means the display dimensions
 *   are the stored ones swapped, which is the difference between a portrait
 *   video embedding correctly and embedding on its side.
 *
 * Only the header is read, not the whole file — `moov` is a few kilobytes and
 * may sit at either end of the file, so both ends get a look.
 */
export function probeMp4(absPath: string): VideoInfo | null {
  let fd: number | null = null
  try {
    fd = fs.openSync(absPath, 'r')
    const size = fs.fstatSync(fd).size

    // `moov` is at the start in a streamable file and at the end otherwise.
    // A megabyte from each end covers both without reading a whole video.
    const window = Math.min(size, 1024 * 1024)
    const head = Buffer.alloc(window)
    fs.readSync(fd, head, 0, window, 0)

    let result = findTkhd(head)
    if (!result && size > window) {
      const tail = Buffer.alloc(window)
      fs.readSync(fd, tail, 0, window, size - window)
      result = findTkhd(tail)
    }
    return result
  } catch {
    return null
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}

/** Scan a buffer for a `tkhd` box carrying non-zero dimensions. */
function findTkhd(buf: Buffer): VideoInfo | null {
  // Locating the box by signature rather than by walking the tree from the
  // top: the tree walk needs the whole `moov` to be present, and a window that
  // clips it would give up on a file whose tkhd is plainly right there.
  let offset = 0

  while (offset >= 0 && offset < buf.length - 4) {
    const found = buf.indexOf('tkhd', offset, 'ascii')
    if (found === -1) return null
    offset = found + 4

    // tkhd body starts right after the type: version(1) flags(3), then
    // timestamps whose width depends on the version.
    const bodyStart = found + 4
    if (bodyStart + 4 > buf.length) return null

    const version = buf[bodyStart]
    // v0: created(4) modified(4) trackID(4) reserved(4) duration(4)  = 20
    // v1: created(8) modified(8) trackID(4) reserved(4) duration(8)  = 32
    const timesLen = version === 1 ? 32 : 20
    // then reserved(8) layer(2) altGroup(2) volume(2) reserved(2) = 16
    // then the 9-entry matrix, 4 bytes each = 36
    const matrixStart = bodyStart + 4 + timesLen + 16
    const dimsStart = matrixStart + 36

    if (dimsStart + 8 > buf.length) continue

    const width = buf.readUInt32BE(dimsStart) / 65536
    const height = buf.readUInt32BE(dimsStart + 4) / 65536

    // Audio and subtitle tracks carry zeroes; keep looking for the video one.
    if (width <= 0 || height <= 0) continue
    if (!Number.isFinite(width) || !Number.isFinite(height)) continue
    // A sanity ceiling — a misparse produces enormous nonsense rather than a
    // plausible-but-wrong number, so this catches it.
    if (width > 20000 || height > 20000) continue

    // Matrix entries a and b, as 16.16 fixed point. A quarter turn puts a at 0
    // and b at ±1, which means the stored dimensions are swapped on screen.
    const a = buf.readInt32BE(matrixStart) / 65536
    const b = buf.readInt32BE(matrixStart + 4) / 65536
    const rotated = Math.abs(a) < 0.01 && Math.abs(b) > 0.99

    return {
      width: Math.round(rotated ? height : width),
      height: Math.round(rotated ? width : height),
      duration: null,
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// ffprobe
// ---------------------------------------------------------------------------

async function probeWithFfprobe(absPath: string): Promise<VideoInfo | null> {
  try {
    const { stdout } = await run(
      'ffprobe',
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height:format=duration',
        '-of', 'json',
        absPath,
      ],
      { timeout: 20_000, maxBuffer: 1024 * 1024 },
    )

    const parsed = JSON.parse(stdout) as {
      streams?: { width?: number; height?: number }[]
      format?: { duration?: string }
    }

    const stream = parsed.streams?.[0]
    const duration = Number(parsed.format?.duration)

    return {
      width: stream?.width ?? null,
      height: stream?.height ?? null,
      duration: Number.isFinite(duration) ? duration : null,
    }
  } catch {
    return null
  }
}

/**
 * Dimensions and duration for a video, by whichever route is available.
 *
 * Returns null only when nothing could be determined, which for a WebM on a
 * server without ffmpeg is the expected outcome — the container parser above
 * handles MP4 and MOV, not EBML.
 */
export async function probeVideo(absPath: string, mime: string | null): Promise<VideoInfo | null> {
  if (await ffmpegAvailable()) {
    const probed = await probeWithFfprobe(absPath)
    if (probed?.width && probed.height) return probed
  }

  const m = (mime ?? '').toLowerCase()
  if (m === 'video/mp4' || m === 'video/quicktime' || m === 'video/x-m4v') {
    return probeMp4(absPath)
  }

  return null
}

// ---------------------------------------------------------------------------
// Poster frames
// ---------------------------------------------------------------------------

/**
 * Extract a still from a video into `destPath` as WebP.
 *
 * Seeks a little way in rather than taking frame zero: the opening frame of a
 * video is very often black or a fade-in, which makes for a poster that says
 * nothing about the content. One second in, or a tenth of the way through for
 * anything shorter.
 *
 * Returns false when ffmpeg is unavailable or the extraction fails, which the
 * caller treats as "this file has no poster" rather than as an error.
 */
export async function extractPoster(
  absPath: string,
  destPath: string,
  duration: number | null,
  maxEdge: number,
): Promise<boolean> {
  if (!(await ffmpegAvailable())) return false

  const seek = duration && duration < 3 ? Math.max(0, duration / 10) : 1

  try {
    await run(
      'ffmpeg',
      [
        '-nostdin',
        '-v', 'error',
        // -ss before -i seeks by keyframe, which is near-instant even on a
        // large file; after -i it would decode everything up to that point.
        '-ss', String(seek),
        '-i', absPath,
        '-frames:v', '1',
        '-vf', `scale='min(${maxEdge},iw)':-2`,
        '-f', 'webp',
        '-quality', '78',
        '-y', destPath,
      ],
      { timeout: 30_000 },
    )

    const stat = await fsp.stat(destPath).catch(() => null)
    return !!stat && stat.size > 0
  } catch (err) {
    console.warn('[media] poster extraction failed', absPath, err)
    await fsp.rm(destPath, { force: true }).catch(() => {})
    return false
  }
}
