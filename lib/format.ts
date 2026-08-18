const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

export function formatBytes(bytes: number, decimals = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1)
  const value = bytes / 1024 ** i
  return `${value.toFixed(value >= 100 ? 0 : decimals)} ${UNITS[i]}`
}

export function formatRate(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  if (seconds < 60) return `${Math.ceil(seconds)}s`
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60)
    return `${m}m ${Math.round(seconds % 60)}s`
  }
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  return `${h}h ${m}m`
}

/**
 * Short human label for a file's type — "PNG image", "MP4 video", "ZIP archive".
 *
 * Falls back to the extension, then to the raw mime, then to "file". A link
 * preview reading "application/vnd.rar" tells a reader nothing they wanted to
 * know; "RAR archive" tells them whether they can open it.
 */
export function describeType(mime: string | null | undefined, name?: string): string {
  const m = (mime ?? '').toLowerCase()
  const ext = name?.split('.').pop()?.toUpperCase() ?? ''

  const subtype = m.split('/')[1]?.split(';')[0]?.replace(/^x-/, '') ?? ''
  const label = subtype ? subtype.toUpperCase() : ext

  if (m.startsWith('image/')) return `${label} image`
  if (m.startsWith('video/')) return `${label} video`
  if (m.startsWith('audio/')) return `${label} audio`
  if (m.startsWith('text/')) return `${label} text`
  if (/zip|rar|7z|tar|gzip|compressed/.test(m)) return `${label} archive`
  if (m === 'application/pdf') return 'PDF document'

  if (ext) return `${ext} file`
  return mime || 'file'
}

export function formatDate(ms: number | null | undefined): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function formatRelative(ms: number | null | undefined): string {
  if (!ms) return '—'
  const diff = Date.now() - ms
  const abs = Math.abs(diff)
  const units: [number, Intl.RelativeTimeFormatUnit][] = [
    [86400_000 * 365, 'year'],
    [86400_000 * 30, 'month'],
    [86400_000 * 7, 'week'],
    [86400_000, 'day'],
    [3600_000, 'hour'],
    [60_000, 'minute'],
  ]
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  for (const [size, unit] of units) {
    if (abs >= size) return rtf.format(-Math.round(diff / size), unit)
  }
  return 'just now'
}
