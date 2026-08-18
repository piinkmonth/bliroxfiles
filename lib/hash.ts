import crypto from 'node:crypto'
import fs from 'node:fs'
import { pipeline } from 'node:stream/promises'

/** Streaming SHA-256 — never loads a 15 GB file into memory. */
export async function sha256File(absPath: string): Promise<string> {
  const hash = crypto.createHash('sha256')
  await pipeline(fs.createReadStream(absPath, { highWaterMark: 4 * 1024 * 1024 }), hash)
  return hash.digest('hex')
}

export function sha256Buffer(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/**
 * Perceptual hash (dHash, 64-bit) for images.
 *
 * SHA-256 only catches byte-identical re-uploads; a single re-encode defeats
 * it. dHash compares adjacent pixel brightness in a 9x8 greyscale reduction,
 * so it survives re-encoding, rescaling, and mild colour shifts — which is
 * what actually happens when banned content gets re-uploaded.
 *
 * Returns null for anything that isn't a decodable image.
 */
export async function perceptualHash(absPath: string): Promise<string | null> {
  /*
   * sharp's two builds disagree about shape: the ESM one has
   * `export default sharp`, while the CJS one makes `module.exports` the
   * function itself with no `.default` at all. Next resolves the ESM path, but
   * anything that loads this module as CommonJS gets `undefined` from
   * `.default` and fails silently. Accept either.
   *
   * The type comes from `.default` because `typeof import('sharp')` is the
   * namespace, which has no call signature.
   */
  let sharp: typeof import('sharp').default
  try {
    const mod = await import('sharp')
    sharp = (mod.default ?? (mod as unknown)) as typeof import('sharp').default
    if (typeof sharp !== 'function') throw new Error('sharp did not export a function')
  } catch {
    return null
  }

  try {
    const { data } = await sharp(absPath, { failOn: 'none', limitInputPixels: 268_402_689 })
      .greyscale()
      .resize(9, 8, { fit: 'fill', kernel: 'lanczos3' })
      .raw()
      .toBuffer({ resolveWithObject: true })

    // 8 rows x 8 comparisons of horizontally adjacent pixels = 64 bits.
    let bits = 0n
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const left = data[row * 9 + col]
        const right = data[row * 9 + col + 1]
        bits = (bits << 1n) | (left > right ? 1n : 0n)
      }
    }
    return bits.toString(16).padStart(16, '0')
  } catch {
    return null
  }
}

/** Bit difference between two hex-encoded perceptual hashes. */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return Number.MAX_SAFE_INTEGER
  let diff = BigInt(`0x${a}`) ^ BigInt(`0x${b}`)
  let count = 0
  while (diff > 0n) {
    count += Number(diff & 1n)
    diff >>= 1n
  }
  return count
}

/**
 * Distance at or below which two images are treated as the same content.
 *
 * 10/64 is the conventional dHash threshold — tight enough that unrelated
 * images effectively never collide, loose enough to survive a re-encode.
 */
export const PHASH_MATCH_THRESHOLD = 10

/** Cheap check for whether perceptual hashing is worth attempting. */
export function isImageMime(mime: string | null | undefined): boolean {
  if (!mime) return false
  return /^image\/(jpeg|png|gif|webp|avif|tiff|bmp)$/i.test(mime)
}
