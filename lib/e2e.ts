/**
 * end-to-end encryption for folders. browser-only — everything here runs client
 * side and the derived key NEVER leaves the tab.
 *
 * the choices here are load-bearing, so:
 *
 * - PBKDF2-SHA256, 600k iters. argon2id is stronger but its not in WebCrypto and
 *   shipping a WASM build to audit isnt worth it. 600k is the current OWASP
 *   number for PBKDF2-HMAC-SHA256.
 * - framed AES-GCM, not one giant blob. the file is encrypted as independent
 *   1 MiB frames. one GCM op over a multi-gb buffer would need the whole
 *   plaintext AND ciphertext in memory at once, and kills partial decryption.
 * - deterministic per-frame IVs: 8 random bytes fixed per file + a 4-byte
 *   big-endian frame counter. reusing an IV under one key totally breaks AES-GCM,
 *   so the counter keeps them unique without storing an IV per frame. the random
 *   prefix means two files never share an IV sequence.
 * - a size cap. ciphertext is assembled as a Blob of frames so the browser holds
 *   the encrypted copy — fine for docs + keys (what encrypted folders are for),
 *   not fine for a 15 GB video. we enforce the cap instead of letting it OOM
 *   confusingly.
 */

// plaintext bytes per frame
export const FRAME_SIZE = 1024 * 1024
// AES-GCM auth tag, appended to every frame
export const TAG_SIZE = 16
// biggest file we let into an encrypted folder
export const MAX_ENCRYPTED_BYTES = 2 * 1024 * 1024 * 1024

export const PBKDF2_ITERATIONS = 600_000

export interface KdfParams {
  algorithm: 'PBKDF2-SHA256'
  iterations: number
}

// stored on the folder row. no secret in here
export interface FolderCrypto {
  kdfSalt: string
  kdfParams: string
  verifier: string
}

// stored on the file row. no secret in here
export interface FileCrypto {
  // base64 of the 8-byte IV prefix for this file
  ivPrefix: string
  frameSize: number
  // plaintext length, so decrypt knows where the last frame ends
  plainSize: number
  originalName: string
  originalMime: string
}

const enc = new TextEncoder()
const dec = new TextDecoder()

function toB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

// returns an ArrayBuffer not a Uint8Array on purpose: TS's newer lib types make
// `Uint8Array<ArrayBufferLike>` unassignable to `BufferSource` (what every
// WebCrypto call wants), so handing back the buffer avoids casts everywhere.
function fromB64(b64: string): ArrayBuffer {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out.buffer as ArrayBuffer
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

export async function deriveKey(
  passphrase: string,
  saltB64: string,
  iterations = PBKDF2_ITERATIONS,
): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    'raw',
    // NFKC so the same passphrase derives the same key even if it got typed with
    // different Unicode normalisation on another platform
    enc.encode(passphrase.normalize('NFKC')).buffer as ArrayBuffer,
    'PBKDF2',
    false,
    ['deriveKey'],
  )

  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: fromB64(saltB64), iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

const VERIFIER_PLAINTEXT = 'blirox-folder-verifier-v1'

/**
 * make the stuff we store against a new encrypted folder.
 *
 * the verifier is just that constant encrypted under the derived key. checking a
 * passphrase = try to decrypt it; wrong passphrase fails the GCM auth tag. tells
 * u nothing about the key, and the server never sees anything password-derived.
 */
export async function createFolderCrypto(passphrase: string): Promise<FolderCrypto> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const saltB64 = toB64(salt)
  const key = await deriveKey(passphrase, saltB64)

  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(VERIFIER_PLAINTEXT).buffer as ArrayBuffer,
  )

  const params: KdfParams = { algorithm: 'PBKDF2-SHA256', iterations: PBKDF2_ITERATIONS }
  return {
    kdfSalt: saltB64,
    kdfParams: JSON.stringify(params),
    verifier: `${toB64(iv)}.${toB64(ct)}`,
  }
}

/** check a passphrase against a folder's stored verifier. */
export async function unlockFolder(
  passphrase: string,
  folder: { kdf_salt: string | null; kdf_params: string | null; verifier: string | null },
): Promise<CryptoKey | null> {
  if (!folder.kdf_salt || !folder.verifier) return null

  let iterations = PBKDF2_ITERATIONS
  try {
    if (folder.kdf_params) iterations = (JSON.parse(folder.kdf_params) as KdfParams).iterations
  } catch {
    /* fall back to the default */
  }

  const key = await deriveKey(passphrase, folder.kdf_salt, iterations)
  const [ivB64, ctB64] = folder.verifier.split('.')

  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(ivB64) },
      key,
      fromB64(ctB64),
    )
    return dec.decode(plain) === VERIFIER_PLAINTEXT ? key : null
  } catch {
    // auth failed — wrong passphrase
    return null
  }
}

// ---------------------------------------------------------------------------
// Short-string encryption — folder names
// ---------------------------------------------------------------------------

/**
 * encrypt a folder name. fresh random IV per call, prefixed to the ciphertext —
 * unlike file frames theres no counter here to keep IVs unique, and the same
 * name might get encrypted many times under one key.
 */
export async function encryptString(plain: string, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(plain).buffer as ArrayBuffer,
  )
  return `${toB64(iv)}.${toB64(ct)}`
}

/** null if the value cant be decrypted with this key. */
export async function decryptString(value: string, key: CryptoKey): Promise<string | null> {
  try {
    const [ivB64, ctB64] = value.split('.')
    if (!ivB64 || !ctB64) return null
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(ivB64) },
      key,
      fromB64(ctB64),
    )
    return dec.decode(plain)
  } catch {
    return null
  }
}

/**
 * stable label shown while a folder is locked. the real name is ciphertext, so
 * we need SOMETHING to tell two locked folders apart — 6 chars of the folder id
 * are meaningless but consistent, which does the job.
 */
export function lockedFolderLabel(folderId: string): string {
  return `Locked · ${folderId.slice(0, 6)}`
}

// ---------------------------------------------------------------------------
// File encryption
// ---------------------------------------------------------------------------

/**
 * IV = 8-byte per-file prefix || 4-byte big-endian frame index. returns the
 * backing ArrayBuffer for the same `BufferSource` typing reason as fromB64 above.
 */
function frameIv(prefix: Uint8Array, index: number): ArrayBuffer {
  const buf = new ArrayBuffer(12)
  const iv = new Uint8Array(buf)
  iv.set(prefix, 0)
  new DataView(buf).setUint32(8, index, false)
  return buf
}

export function encryptedSize(plainSize: number): number {
  return plainSize + Math.max(1, Math.ceil(plainSize / FRAME_SIZE)) * TAG_SIZE
}

/**
 * encrypt a file into a Blob of framed ciphertext. frames go in as separate Blob
 * parts instead of one concatenated ArrayBuffer, so the browser can back them
 * with its own storage instead of forcing one contiguous alloc the size of the
 * whole file.
 */
export async function encryptFile(
  file: File,
  key: CryptoKey,
  onProgress?: (fraction: number) => void,
): Promise<{ blob: Blob; meta: FileCrypto }> {
  if (file.size > MAX_ENCRYPTED_BYTES) {
    throw new Error(
      `Encrypted folders take files up to ${MAX_ENCRYPTED_BYTES / 1024 ** 3} GB. ` +
        `This one is ${(file.size / 1024 ** 3).toFixed(1)} GB — put it in a normal folder.`,
    )
  }

  const prefix = crypto.getRandomValues(new Uint8Array(8))
  const frames: BlobPart[] = []
  const total = Math.max(1, Math.ceil(file.size / FRAME_SIZE))

  for (let i = 0; i < total; i++) {
    const slice = file.slice(i * FRAME_SIZE, Math.min((i + 1) * FRAME_SIZE, file.size))
    const plain = await slice.arrayBuffer()
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: frameIv(prefix, i) }, key, plain)
    frames.push(ct)
    onProgress?.((i + 1) / total)
  }

  return {
    blob: new Blob(frames, { type: 'application/octet-stream' }),
    meta: {
      ivPrefix: toB64(prefix),
      frameSize: FRAME_SIZE,
      plainSize: file.size,
      originalName: file.name,
      originalMime: file.type || 'application/octet-stream',
    },
  }
}

/** reverse of encryptFile. throws if any frame fails auth. */
export async function decryptBlob(
  ciphertext: Blob,
  key: CryptoKey,
  meta: FileCrypto,
  onProgress?: (fraction: number) => void,
): Promise<Blob> {
  const prefix = new Uint8Array(fromB64(meta.ivPrefix))
  const cipherFrame = meta.frameSize + TAG_SIZE
  const total = Math.max(1, Math.ceil(meta.plainSize / meta.frameSize))
  const parts: BlobPart[] = []

  for (let i = 0; i < total; i++) {
    const slice = ciphertext.slice(i * cipherFrame, Math.min((i + 1) * cipherFrame, ciphertext.size))
    const buf = await slice.arrayBuffer()
    try {
      parts.push(
        await crypto.subtle.decrypt({ name: 'AES-GCM', iv: frameIv(prefix, i) }, key, buf),
      )
    } catch {
      throw new Error(
        `Decryption failed at frame ${i + 1} of ${total}. The file is damaged or was ` +
          `encrypted with a different passphrase.`,
      )
    }
    onProgress?.((i + 1) / total)
  }

  return new Blob(parts, { type: meta.originalMime || 'application/octet-stream' })
}

// ---------------------------------------------------------------------------
// In-memory key cache
// ---------------------------------------------------------------------------

/**
 * unlocked folder keys, this tab only. deliberately a plain module-level Map —
 * NEVER sessionStorage/localStorage, those persist to disk and outlive the tab.
 * closing the tab re-locks every folder, which is what u expect from an
 * encrypted folder.
 */
const unlocked = new Map<string, CryptoKey>()

export function cacheKey(folderId: string, key: CryptoKey): void {
  unlocked.set(folderId, key)
}

export function cachedKey(folderId: string): CryptoKey | undefined {
  return unlocked.get(folderId)
}

export function forgetKey(folderId: string): void {
  unlocked.delete(folderId)
}

export function forgetAllKeys(): void {
  unlocked.clear()
}
