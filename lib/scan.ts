import net from 'node:net'
import fs from 'node:fs'
import { pipeline } from 'node:stream/promises'

/**
 * Malware scanning.
 *
 * Two independent signals, deliberately in this order:
 *
 *  1. ClamAV, locally over its INSTREAM socket. Files never leave the server,
 *     there is no per-request cost, and it works on content rather than
 *     reputation. This is the one that matters.
 *
 *  2. VirusTotal, by SHA-256 only. Never the file — just the hash, so nothing
 *     of the user's content is disclosed to a third party. Catches known
 *     samples ClamAV's signatures have missed, at the cost of only detecting
 *     things somebody has already submitted.
 *
 * Both are optional. If neither is configured, uploads proceed unscanned and
 * that is reported honestly rather than silently pretending files were checked.
 */

/**
 * Prefer clamd's unix socket over TCP.
 *
 * Debian's packaged clamav-daemon listens on /var/run/clamav/clamd.ctl and not
 * on TCP at all unless you edit clamd.conf. The socket is also the better
 * choice: no listener exposed on the network, and filesystem permissions do
 * the access control.
 */
const CLAMAV_SOCKET = process.env.BLIROX_CLAMAV_SOCKET ?? '/var/run/clamav/clamd.ctl'
const CLAMAV_HOST = process.env.BLIROX_CLAMAV_HOST ?? '127.0.0.1'
const CLAMAV_PORT = Number(process.env.BLIROX_CLAMAV_PORT ?? 3310)
const CLAMAV_USE_TCP = process.env.BLIROX_CLAMAV_USE_TCP === '1'
const CLAMAV_ENABLED = process.env.BLIROX_CLAMAV_ENABLED === '1'

const VT_KEY = process.env.BLIROX_VIRUSTOTAL_KEY ?? ''

/** Files above this are hashed for VirusTotal but not streamed to ClamAV. */
const CLAMAV_MAX_BYTES = Number(process.env.BLIROX_CLAMAV_MAX_MB ?? 512) * 1024 * 1024

export type ScanVerdict = 'clean' | 'infected' | 'unscanned' | 'error'

export interface ScanResult {
  verdict: ScanVerdict
  /** Signature or detection name when infected. */
  threat?: string
  engine?: 'clamav' | 'virustotal'
  detail?: string
}

// ---------------------------------------------------------------------------
// ClamAV — INSTREAM over TCP
// ---------------------------------------------------------------------------

/**
 * Stream a file to clamd.
 *
 * INSTREAM framing is: `zINSTREAM\0`, then repeated <4-byte big-endian length>
 * <chunk>, then a zero-length chunk to finish. clamd replies with a single
 * line ending in "OK" or "FOUND".
 */
function clamavScan(absPath: string, sizeBytes: number): Promise<ScanResult> {
  return new Promise((resolve) => {
    if (sizeBytes > CLAMAV_MAX_BYTES) {
      resolve({
        verdict: 'unscanned',
        engine: 'clamav',
        detail: `file exceeds the ${Math.round(CLAMAV_MAX_BYTES / 1024 / 1024)} MB scan limit`,
      })
      return
    }

    const socket = CLAMAV_USE_TCP
      ? net.createConnection({ host: CLAMAV_HOST, port: CLAMAV_PORT })
      : net.createConnection(CLAMAV_SOCKET)
    let reply = ''
    let settled = false

    const done = (result: ScanResult) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }

    // clamd can hang on a malformed stream; do not let that hold an upload open.
    socket.setTimeout(120_000, () =>
      done({ verdict: 'error', engine: 'clamav', detail: 'clamd timed out' }),
    )

    socket.on('error', (err) =>
      done({
        verdict: 'error',
        engine: 'clamav',
        detail:
          `clamd unreachable (${CLAMAV_USE_TCP ? `${CLAMAV_HOST}:${CLAMAV_PORT}` : CLAMAV_SOCKET}): ` +
          err.message,
      }),
    )

    socket.on('data', (buf) => {
      reply += buf.toString('utf8')
    })

    socket.on('end', () => {
      /*
       * The `z` command prefix asks clamd to NUL-terminate its reply, so the
       * response is "stream: OK\0". String.trim() does not strip NUL, which
       * meant `endsWith('OK')` was false for every clean file — they were all
       * recorded as scan errors — and the trailing NUL leaked into detection
       * names. Strip control characters before parsing anything.
       */
      // eslint-disable-next-line no-control-regex
      const line = reply.replace(/\0/g, '').trim()

      if (line.endsWith('OK') && !line.includes('FOUND')) {
        done({ verdict: 'clean', engine: 'clamav' })
      } else if (line.includes('FOUND')) {
        // "stream: Eicar-Test-Signature FOUND"
        const threat = line.replace(/^stream:\s*/, '').replace(/\s*FOUND$/, '').trim()
        done({ verdict: 'infected', engine: 'clamav', threat: threat || 'unknown' })
      } else {
        done({ verdict: 'error', engine: 'clamav', detail: line || 'empty reply' })
      }
    })

    socket.on('connect', async () => {
      try {
        socket.write('zINSTREAM\0')

        const input = fs.createReadStream(absPath, { highWaterMark: 1024 * 1024 })
        for await (const chunk of input) {
          const buf = chunk as Buffer
          const header = Buffer.alloc(4)
          header.writeUInt32BE(buf.length, 0)
          if (!socket.write(Buffer.concat([header, buf]))) {
            await new Promise((r) => socket.once('drain', r))
          }
        }

        // Zero-length chunk terminates the stream.
        const terminator = Buffer.alloc(4)
        terminator.writeUInt32BE(0, 0)
        socket.write(terminator)
      } catch (err) {
        done({
          verdict: 'error',
          engine: 'clamav',
          detail: err instanceof Error ? err.message : 'stream failed',
        })
      }
    })
  })
}

// ---------------------------------------------------------------------------
// VirusTotal — hash lookup only
// ---------------------------------------------------------------------------

/**
 * Look a SHA-256 up on VirusTotal.
 *
 * Only the hash is transmitted. A 404 means nobody has submitted this sample,
 * which is not evidence of anything either way — most legitimate files are
 * unknown to VT.
 */
async function virusTotalLookup(sha256: string): Promise<ScanResult> {
  if (!VT_KEY) return { verdict: 'unscanned', engine: 'virustotal' }

  try {
    const res = await fetch(`https://www.virustotal.com/api/v3/files/${sha256}`, {
      headers: { 'x-apikey': VT_KEY },
      signal: AbortSignal.timeout(15_000),
    })

    if (res.status === 404) {
      return { verdict: 'unscanned', engine: 'virustotal', detail: 'sample not known to VirusTotal' }
    }
    if (!res.ok) {
      return { verdict: 'error', engine: 'virustotal', detail: `HTTP ${res.status}` }
    }

    const body = (await res.json()) as {
      data?: { attributes?: { last_analysis_stats?: Record<string, number> } }
    }
    const stats = body.data?.attributes?.last_analysis_stats
    if (!stats) return { verdict: 'error', engine: 'virustotal', detail: 'unexpected response' }

    const malicious = stats.malicious ?? 0
    const suspicious = stats.suspicious ?? 0

    /*
     * Threshold rather than "any detection at all": single-vendor hits on
     * VirusTotal are overwhelmingly false positives, especially for installers,
     * game mods, packers and cracked software. Three independent engines is the
     * conventional line for treating a result as real.
     */
    if (malicious >= 3) {
      return {
        verdict: 'infected',
        engine: 'virustotal',
        threat: `${malicious} engines flagged this`,
      }
    }

    if (malicious + suspicious > 0) {
      return {
        verdict: 'clean',
        engine: 'virustotal',
        detail: `${malicious} malicious / ${suspicious} suspicious — below the action threshold`,
      }
    }

    return { verdict: 'clean', engine: 'virustotal' }
  } catch (err) {
    return {
      verdict: 'error',
      engine: 'virustotal',
      detail: err instanceof Error ? err.message : 'lookup failed',
    }
  }
}

// ---------------------------------------------------------------------------

export function scanningConfigured(): { clamav: boolean; virustotal: boolean } {
  return { clamav: CLAMAV_ENABLED, virustotal: !!VT_KEY }
}

/**
 * Scan a finished upload. Never throws — a scanner being down must not fail an
 * upload, but the resulting verdict says so rather than claiming 'clean'.
 */
export async function scanFile(opts: {
  absPath: string
  sizeBytes: number
  sha256: string
}): Promise<ScanResult> {
  const enabled = scanningConfigured()

  if (enabled.clamav) {
    const local = await clamavScan(opts.absPath, opts.sizeBytes)
    // A local detection is decisive; don't spend a VT quota unit confirming it.
    if (local.verdict === 'infected') return local
    if (local.verdict === 'error') {
      console.error('[scan] clamav:', local.detail)
    }

    if (enabled.virustotal) {
      const remote = await virusTotalLookup(opts.sha256)
      if (remote.verdict === 'infected') return remote
      if (local.verdict === 'clean' || remote.verdict === 'clean') {
        return { verdict: 'clean', engine: local.verdict === 'clean' ? 'clamav' : 'virustotal' }
      }
    }

    return local
  }

  if (enabled.virustotal) return virusTotalLookup(opts.sha256)

  return { verdict: 'unscanned', detail: 'no scanner configured' }
}
