'use client'

import { useCallback, useRef, useState } from 'react'
import { Upload, X, Check, AlertCircle, Copy, RotateCw, Loader2 } from 'lucide-react'
import { formatBytes, formatRate, formatDuration } from '@/lib/format'
import { encryptFile, encryptedSize, cachedKey } from '@/lib/e2e'

type Phase = 'queued' | 'encrypting' | 'uploading' | 'assembling' | 'done' | 'error' | 'cancelled'

interface Job {
  id: string
  file: File
  phase: Phase
  uploadId?: string
  bytesSent: number
  bytesPerSec: number
  etaSeconds: number
  error?: string
  url?: string
  duplicate?: boolean
}

/**
 * Chunks in flight at once, across every file being uploaded.
 *
 * This is deliberately global rather than per-file. Eight files each running
 * six workers would be 48 concurrent requests — browsers cap connections per
 * origin anyway (~6), so the extra ones just queue invisibly, and on a home
 * uplink that much parallelism starves everything else on the network. One
 * shared pool keeps total concurrency predictable however many files are
 * queued, and each file's progress bar still moves independently.
 */
const PARALLEL = 6

/**
 * Counting semaphore with direct hand-off: a released slot goes straight to
 * the next waiter rather than being returned to the pool and re-contended for,
 * which keeps chunk order roughly FIFO instead of arbitrary.
 */
class Semaphore {
  private active = 0
  private waiters: (() => void)[] = []

  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++
      return
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve))
    // The releasing caller handed its slot over; `active` is already correct.
  }

  release(): void {
    const next = this.waiters.shift()
    if (next) next()
    else this.active--
  }
}

const uploadSlots = new Semaphore(PARALLEL)
/** Per-chunk retry budget before the whole upload is failed. */
const MAX_RETRIES = 5

/**
 * PUT a chunk with live progress.
 *
 * fetch() cannot report upload progress — there is no event for it — so a
 * fetch-based uploader can only move the bar once a whole chunk lands. At
 * 64 MB chunks that means most files sit at 0% and then snap to 100%.
 * XMLHttpRequest still exposes upload.onprogress, so it is the right tool here
 * despite being the older API.
 */
function putChunk(opts: {
  url: string
  body: Blob
  onProgress: (bytesSent: number) => void
  signal: AbortSignal
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', opts.url)
    xhr.responseType = 'text'

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) opts.onProgress(e.loaded)
    }

    xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText })
    xhr.onerror = () => reject(new Error('Network error'))
    xhr.ontimeout = () => reject(new Error('Timed out'))
    xhr.onabort = () => reject(new Error('cancelled'))

    opts.signal.addEventListener('abort', () => xhr.abort(), { once: true })
    xhr.send(opts.body)
  })
}

export function Uploader({
  onComplete,
  folderId = null,
  encrypted = false,
}: {
  onComplete?: () => void
  folderId?: string | null
  /** True when the current folder is end-to-end encrypted. */
  encrypted?: boolean
}) {
  const [jobs, setJobs] = useState<Job[]>([])
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const aborters = useRef(new Map<string, AbortController>())

  const update = useCallback((id: string, patch: Partial<Job>) => {
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, ...patch } : j)))
  }, [])

  const run = useCallback(
    async (job: Job) => {
      const { file } = job
      const aborter = new AbortController()
      aborters.current.set(job.id, aborter)
      update(job.id, { phase: 'uploading', bytesSent: 0 })

      try {
        // ---- Encrypt first, if this folder is encrypted --------------------
        //
        // Encryption happens before the session is opened because the declared
        // size must be the *ciphertext* length — the server reserves quota and
        // validates every chunk against it.
        let body: Blob = file
        let encMeta: string | null = null

        if (encrypted) {
          const key = folderId ? cachedKey(folderId) : undefined
          if (!key) throw new Error('This folder is locked — unlock it before uploading')

          update(job.id, { phase: 'encrypting' })
          const result = await encryptFile(file, key, (fraction) =>
            update(job.id, { bytesSent: Math.round(fraction * file.size) }),
          )
          body = result.blob
          encMeta = JSON.stringify(result.meta)
          update(job.id, { phase: 'uploading', bytesSent: 0 })
        }

        const declaredSize = encrypted ? encryptedSize(file.size) : file.size

        // ---- Open a session; quota is checked before any bytes move --------
        const initRes = await fetch('/api/upload/init', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filename: file.name,
            sizeBytes: declaredSize,
            mime: encrypted ? 'application/octet-stream' : file.type || 'application/octet-stream',
            folderId,
            encMeta,
          }),
        })
        const init = await initRes.json()
        if (!init.ok) throw new Error(init.error || 'Could not start upload')

        const { uploadId, chunkBytes, totalChunks } = init
        update(job.id, { uploadId })

        // ---- Send chunks ---------------------------------------------------
        const startedAt = Date.now()
        // Bytes from chunks that have fully landed.
        let settledBytes = 0
        // Live byte counts for chunks currently in flight, keyed by index.
        // Summing these with settledBytes is what makes the bar move smoothly
        // even when three chunks are uploading at once.
        const inFlight = new Map<number, number>()

        /*
         * Throughput is measured over a sliding window, not as bytes/elapsed.
         *
         * A cumulative average is permanently weighed down by the slow first
         * seconds of TCP slow start: at a true 7 MB/s it still reads 5.2 after
         * ten seconds and only reaches 6.7 after a minute. That looks like a
         * connection taking forever to ramp up when in fact it got there almost
         * immediately — the number was just wrong.
         *
         * Sampling every ~250 ms and smoothing with an EWMA gives the current
         * rate, responsive enough to show a stall but steady enough not to
         * flicker on every progress event.
         */
        let sampleBytes = 0
        let sampleAt = startedAt
        let smoothedRate = 0
        const SMOOTHING = 0.3

        const report = () => {
          let live = 0
          for (const n of inFlight.values()) live += n
          const sent = Math.min(settledBytes + live, declaredSize)

          const now = Date.now()
          const dt = (now - sampleAt) / 1000

          if (dt >= 0.25) {
            const instant = Math.max(0, (sent - sampleBytes) / dt)
            smoothedRate =
              smoothedRate === 0 ? instant : smoothedRate * (1 - SMOOTHING) + instant * SMOOTHING
            sampleBytes = sent
            sampleAt = now
          }

          update(job.id, {
            bytesSent: sent,
            bytesPerSec: smoothedRate,
            etaSeconds: smoothedRate > 0 ? (declaredSize - sent) / smoothedRate : 0,
          })
        }

        const pending = Array.from({ length: totalChunks }, (_, i) => i)

        const sendChunk = async (index: number) => {
          const start = index * chunkBytes
          const blob = body.slice(start, Math.min(start + chunkBytes, body.size))

          for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            if (aborter.signal.aborted) throw new Error('cancelled')
            inFlight.set(index, 0)

            // Gate on the global pool, not the per-file worker count.
            await uploadSlots.acquire()

            try {
              const res = await putChunk({
                url: `/api/upload/${uploadId}/chunk/${index}`,
                body: blob,
                signal: aborter.signal,
                onProgress: (loaded) => {
                  inFlight.set(index, loaded)
                  report()
                },
              })

              if (res.status >= 200 && res.status < 300) {
                inFlight.delete(index)
                settledBytes += blob.size
                report()
                return
              }

              // 4xx other than 429 means the request itself is wrong; retrying
              // an identical request will fail identically.
              if (res.status >= 400 && res.status < 500 && res.status !== 429) {
                let message = `Chunk ${index} rejected (${res.status})`
                try {
                  message = JSON.parse(res.body).error || message
                } catch {
                  /* non-JSON error body */
                }
                throw new Error(message)
              }
            } catch (err) {
              if (err instanceof Error && err.message === 'cancelled') throw err
              if (attempt === MAX_RETRIES) throw err
            } finally {
              // Always give the slot back, including on abort and on the
              // early `return` in the success path — a leaked slot would
              // permanently shrink the pool.
              uploadSlots.release()
              // Drop the partial count so a retry doesn't double-count bytes.
              inFlight.delete(index)
              report()
            }

            // Exponential backoff, capped, with jitter so parallel retries
            // don't resynchronise into a thundering herd.
            const backoff = Math.min(1000 * 2 ** attempt, 15_000)
            await sleep(backoff * (0.5 + Math.random() * 0.5))
          }

          throw new Error(`Chunk ${index} failed after ${MAX_RETRIES} retries`)
        }

        // Fixed-size worker pool pulling off a shared queue.
        const workers = Array.from({ length: Math.min(PARALLEL, totalChunks) }, async () => {
          for (;;) {
            const next = pending.shift()
            if (next === undefined) return
            await sendChunk(next)
          }
        })
        await Promise.all(workers)

        // ---- Assemble ------------------------------------------------------
        update(job.id, { phase: 'assembling', bytesSent: declaredSize })
        const doneRes = await fetch(`/api/upload/${uploadId}/complete`, { method: 'POST' })
        const done = await doneRes.json()
        if (!done.ok) throw new Error(done.error || 'Could not finish upload')

        update(job.id, {
          phase: 'done',
          url: done.url,
          duplicate: done.duplicate,
          bytesSent: file.size,
        })
        onComplete?.()
      } catch (err) {
        if (aborter.signal.aborted) {
          update(job.id, { phase: 'cancelled' })
          return
        }
        update(job.id, {
          phase: 'error',
          error: err instanceof Error ? err.message : 'Upload failed',
        })
      } finally {
        aborters.current.delete(job.id)
      }
    },
    [update, onComplete, folderId, encrypted],
  )

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const next: Job[] = Array.from(files).map((file) => ({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        file,
        phase: 'queued' as Phase,
        bytesSent: 0,
        bytesPerSec: 0,
        etaSeconds: 0,
      }))
      setJobs((prev) => [...next, ...prev])
      next.forEach(run)
    },
    [run],
  )

  function cancel(job: Job) {
    aborters.current.get(job.id)?.abort()
    update(job.id, { phase: 'cancelled' })
    if (job.uploadId) fetch(`/api/upload/${job.uploadId}`, { method: 'DELETE' }).catch(() => {})
  }

  function retry(job: Job) {
    update(job.id, { phase: 'queued', bytesSent: 0, bytesPerSec: 0, error: undefined })
    run({ ...job, bytesSent: 0, phase: 'queued' })
  }

  return (
    <div className="space-y-4">
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files)
        }}
        onClick={() => inputRef.current?.click()}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-card border border-dashed p-12 text-center transition-colors ${
          dragging
            ? 'border-accent bg-raised'
            : 'border-border bg-surface/[0.55] hover:border-muted'
        }`}
      >
        <Upload size={20} className={dragging ? 'text-accent' : 'text-muted'} />
        <p className="mt-4 font-medium">
          {dragging ? 'Drop it' : 'Drop files here, or click to browse'}
        </p>
        <p className="mt-1 text-sm text-muted">
          {encrypted
            ? 'Encrypted in your browser before upload. Up to 2 GB per file here.'
            : '15GB a file, so you do not fuck up the server'}
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) addFiles(e.target.files)
            e.target.value = ''
          }}
        />
      </div>

      {jobs.length > 0 && (
        <div className="space-y-2">
          {jobs.map((job) => (
            <JobRow key={job.id} job={job} onCancel={() => cancel(job)} onRetry={() => retry(job)} />
          ))}
        </div>
      )}
    </div>
  )
}

function JobRow({ job, onCancel, onRetry }: { job: Job; onCancel: () => void; onRetry: () => void }) {
  const [copied, setCopied] = useState(false)
  const pct = job.file.size > 0 ? Math.min(100, (job.bytesSent / job.file.size) * 100) : 0
  const active =
    job.phase === 'uploading' || job.phase === 'assembling' || job.phase === 'encrypting'

  return (
    <div className="card animate-fade-up p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{job.file.name}</p>
          <p className="mt-0.5 text-sm text-muted">
            {job.phase === 'uploading' && (
              <>
                {formatBytes(job.bytesSent)} of {formatBytes(job.file.size)}
                {job.bytesPerSec > 0 && (
                  <>
                    {' · '}
                    {formatRate(job.bytesPerSec)}
                    {' · '}
                    {formatDuration(job.etaSeconds)} left
                  </>
                )}
              </>
            )}
            {job.phase === 'encrypting' &&
              `${formatBytes(job.file.size)} · encrypting in your browser`}
            {job.phase === 'assembling' && `${formatBytes(job.file.size)} · finishing up`}
            {job.phase === 'queued' && `${formatBytes(job.file.size)} · starting`}
            {(job.phase === 'done' || job.phase === 'error' || job.phase === 'cancelled') &&
              formatBytes(job.file.size)}
            {job.phase === 'done' && job.duplicate && ' · already had this one'}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {active && (
            <span className="font-mono text-sm tabular-nums text-accent">
              {job.phase === 'assembling' ? '100' : pct.toFixed(pct < 10 ? 1 : 0)}%
            </span>
          )}
          {job.phase === 'done' && <Check size={18} className="text-success" />}
          {job.phase === 'error' && <AlertCircle size={18} className="text-danger" />}
          {(job.phase === 'uploading' || job.phase === 'queued') && (
            <button onClick={onCancel} className="text-muted hover:text-danger" aria-label="Cancel">
              <X size={18} />
            </button>
          )}
          {(job.phase === 'error' || job.phase === 'cancelled') && (
            <button onClick={onRetry} className="text-muted hover:text-accent" aria-label="Retry">
              <RotateCw size={16} />
            </button>
          )}
        </div>
      </div>

      {active && (
        <div className="mt-3 h-1.5 overflow-hidden bg-raised">
          <div
            className={`h-full bg-accent transition-[width] duration-200 ease-out ${
              job.phase === 'assembling' ? 'animate-pulse' : ''
            }`}
            style={{ width: `${job.phase === 'assembling' ? 100 : pct}%` }}
          />
        </div>
      )}

      {job.phase === 'assembling' && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-muted">
          <Loader2 size={12} className="animate-spin" />
          Verifying and assembling on the server — this can take a moment for large files.
        </p>
      )}

      {job.phase === 'error' && <p className="mt-2 text-sm text-danger">{job.error}</p>}

      {job.phase === 'done' && job.url && (
        <div className="mt-3 flex items-center gap-2">
          <code className="flex-1 truncate rounded-lg bg-raised/70 px-3 py-2 font-mono text-xs">
            {job.url}
          </code>
          <button
            className="btn-ghost"
            onClick={() => {
              navigator.clipboard.writeText(job.url!)
              setCopied(true)
              setTimeout(() => setCopied(false), 1600)
            }}
          >
            <Copy size={14} />
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}
    </div>
  )
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
