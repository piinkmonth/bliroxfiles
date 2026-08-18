import fs from 'node:fs'
import path from 'node:path'

// central config. everything big is in bytes so nothing else has to guess units

const GB = 1024 ** 3
const MB = 1024 ** 2

function env(key: string, fallback: string): string {
  const v = process.env[key]
  return v === undefined || v === '' ? fallback : v
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key]
  if (v === undefined || v === '') return fallback
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error(`${key} must be a number, got ${v}`)
  return n
}

// root of the uploads drive. nothing gets written outside this
export const STORAGE_ROOT = env('BLIROX_STORAGE_ROOT', '/mnt/blirox-files')

export const PATHS = {
  root: STORAGE_ROOT,
  // finished files, split into folders by the first 4 chars of the id
  blobs: path.join(STORAGE_ROOT, 'blobs'),
  // in-flight chunked uploads, one folder each
  staging: path.join(STORAGE_ROOT, 'staging'),
  // quarantined stuff waiting on mod review. never served
  quarantine: path.join(STORAGE_ROOT, 'quarantine'),
  // pfps, re-encoded on upload
  avatars: path.join(STORAGE_ROOT, 'avatars'),
  // preview thumbs. derived so safe to nuke + rebuild
  thumbs: path.join(STORAGE_ROOT, 'thumbs'),
  // admin-uploaded backgrounds. on the drive not public/ bc next snapshots
  // public/ at boot, so anything written there after isnt served. see lib/backgrounds.ts
  backgrounds: path.join(STORAGE_ROOT, 'backgrounds'),
  // sqlite db + wal
  db: path.join(STORAGE_ROOT, 'db', 'files.db'),
}

export const LIMITS = {
  // space per account. overcommitted on purpose (see the guide)
  defaultQuotaBytes: envInt('BLIROX_DEFAULT_QUOTA_GB', 45) * GB,

  // biggest single file
  maxFileBytes: envInt('BLIROX_MAX_FILE_GB', 15) * GB,

  // cloudflare tunnel kills bodies over 100mb so chunks stay under it.
  // 64mb = ~240 requests for a 15gb file
  chunkBytes: envInt('BLIROX_CHUNK_MB', 64) * MB,

  // hard server ceiling, dont trust the client
  maxChunkBytes: 90 * MB,

  // dead uploads get swept after this
  stagingTtlMs: envInt('BLIROX_STAGING_TTL_HOURS', 48) * 3600_000,

  // uploads going at once per account. each reserves its full size vs quota up
  // front, so eight parallel 15gb uploads die on quota way before they hit this
  maxConcurrentUploads: envInt('BLIROX_MAX_CONCURRENT_UPLOADS', 8),

  // cap for ONE download. not the actual rate — real rate is the smaller of
  // this and the downloads share of the budget below. so one person alone gets
  // the whole budget instead of a slice of an idle link
  downloadBytesPerSec: envInt('BLIROX_DOWNLOAD_KBPS', 9000) * 1024,

  // total egress across all downloads at once. THIS is the real throttle.
  // home link is wifi (~12mb/s), half-duplex so outgoing bytes eat airtime the
  // uploads need. left ~a quarter for ingress + everything else
  egressBudgetBytesPerSec: envInt('BLIROX_EGRESS_BUDGET_KBPS', 9000) * 1024,

  // downloads at once. fairness not bandwidth (budget above handles that). just
  // stops the budget getting sliced so thin everything crawls
  maxConcurrentDownloads: envInt('BLIROX_MAX_CONCURRENT_DOWNLOADS', 8),

  // sessions die after this long unused
  sessionTtlMs: envInt('BLIROX_SESSION_TTL_DAYS', 30) * 86400_000,

  // biggest one-shot api upload (POST /v1/files). under cloudflares 100mb cap.
  // bigger = use the chunked flow (POST /v1/uploads), bounded by maxFileBytes
  apiOneShotBytes: envInt('BLIROX_API_ONESHOT_MB', 90) * MB,
}

export const HOSTS = {
  app: env('BLIROX_APP_HOST', 'files.example.com'),
  // byte-serving hosts. split from the app host so file traffic can move off
  // cloudflare later without touching app urls (cloudflare ToS §2.8 restricts
  // bulk non-html through the cdn). us01 is first bc share links get built from
  // it — numbered so u can add us02/eu01 later without breaking links already out
  cdn: env('BLIROX_CDN_HOSTS', 'us01.example.com')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean),
  // dev api + docs. own host so it can get its own rate limits / move / repoint
  // without touching an app url
  api: env('BLIROX_API_HOST', 'api.example.com'),
}

// public origin we build share links off
export const PUBLIC_ORIGIN = env('BLIROX_PUBLIC_ORIGIN', `https://${HOSTS.app}`)

// origin serving file bytes. falls back to app host if no cdn set
export const CDN_ORIGIN = env(
  'BLIROX_CDN_ORIGIN',
  HOSTS.cdn[0] ? `https://${HOSTS.cdn[0]}` : PUBLIC_ORIGIN,
)

// where the dev api + docs live
export const API_ORIGIN = env('BLIROX_API_ORIGIN', `https://${HOSTS.api}`)

// refuse to boot if storage would land on the OS disk.
// difference between "uploads fail" and "uploads silently fill the root fs til
// the OS dies". the dir existing means nothing — /mnt/blirox-files is there
// whether a drive is mounted on it or not.
// we check against the ROOT fs device, not the parent dir: comparing to the
// parent only works if the storage root IS the mount point, and false-alarms on
// a subdir of a mounted drive. comparing to `/` asks the real question — are
// these bytes about to land on the same disk as the OS?
export function assertStorageMounted(): void {
  if (process.env.BLIROX_ALLOW_UNMOUNTED === '1') return

  if (!fs.existsSync(STORAGE_ROOT)) {
    throw new Error(
      `Storage root ${STORAGE_ROOT} does not exist. Mount the uploads drive first (see the guide).`,
    )
  }

  const here = fs.statSync(STORAGE_ROOT)
  const root = fs.statSync('/')

  if (here.dev === root.dev) {
    throw new Error(
      `${STORAGE_ROOT} is on the same filesystem as / — the uploads drive is not mounted.\n` +
        `Writing here would fill the root filesystem and take the machine down.\n` +
        `Mount the drive, or set BLIROX_ALLOW_UNMOUNTED=1 for local dev.`,
    )
  }
}

// build the dir tree on the drive. safe to call however many times
export function ensureStorageTree(): void {
  assertStorageMounted()
  for (const dir of [
    PATHS.blobs,
    PATHS.staging,
    PATHS.quarantine,
    PATHS.avatars,
    PATHS.thumbs,
    PATHS.backgrounds,
    path.dirname(PATHS.db),
  ]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o750 })
  }
}

export { GB, MB }
