'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Check, Loader2, Shuffle, Image as ImageIcon, Upload, Trash2, Lock,
} from 'lucide-react'
import { formatBytes } from '@/lib/format'
import type { Background, BackgroundMode } from '@/lib/backgrounds'

export function AppearanceClient({
  backgrounds,
  current,
}: {
  backgrounds: Background[]
  current: BackgroundMode
}) {
  const router = useRouter()
  const fileRef = useRef<HTMLInputElement>(null)

  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [mode, setMode] = useState<BackgroundMode>(current)
  const [dragging, setDragging] = useState(false)
  const [queue, setQueue] = useState<{ done: number; total: number } | null>(null)

  async function apply(next: BackgroundMode) {
    setBusy(next.mode === 'fixed' ? next.file : 'daily')
    setError(null)

    const res = await fetch('/api/admin/background', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        next.mode === 'fixed' ? { mode: 'fixed', file: next.file } : { mode: 'daily' },
      ),
    })
    const data = await res.json()
    setBusy(null)

    if (!data.ok) {
      setError(data.error)
      return
    }
    setMode(data.current)
    router.refresh()
  }

  /**
   * Uploaded one at a time rather than in parallel: each is re-encoded by
   * sharp, and a dozen simultaneous 4K decodes would put the whole server
   * under memory pressure for no gain in wall-clock time.
   */
  async function upload(files: File[]) {
    if (files.length === 0) return
    setError(null)
    setWarnings([])
    setQueue({ done: 0, total: files.length })

    const failures: string[] = []
    const notes: string[] = []

    for (let i = 0; i < files.length; i++) {
      const body = new FormData()
      body.append('background', files[i])

      try {
        const res = await fetch('/api/admin/background', { method: 'POST', body })
        const data = await res.json()
        if (!data.ok) failures.push(`${files[i].name}: ${data.error}`)
        // A warning means it uploaded fine and is worth a word about — kept
        // apart from failures so a soft image does not read as a rejection.
        else if (data.warning) notes.push(data.warning)
      } catch {
        failures.push(`${files[i].name}: upload failed`)
      }
      setQueue({ done: i + 1, total: files.length })
    }

    setQueue(null)
    if (failures.length > 0) setError(failures.join('\n'))
    setWarnings(notes)
    router.refresh()
  }

  async function remove(bg: Background) {
    if (!confirm(`Delete "${bg.name}"?\n\nThis removes the image from the server for good.`)) return

    setBusy(bg.url)
    setError(null)

    const res = await fetch(`/api/admin/background?name=${encodeURIComponent(bg.name)}`, {
      method: 'DELETE',
    })
    const data = await res.json()
    setBusy(null)

    if (!data.ok) {
      setError(data.error)
      return
    }
    if (data.current) setMode(data.current)
    router.refresh()
  }

  function pickImages(list: FileList | null): File[] {
    return [...(list ?? [])].filter((f) => f.type.startsWith('image/'))
  }

  const isDaily = mode.mode === 'daily'
  const uploaded = backgrounds.filter((b) => b.source === 'uploaded').length

  return (
    <div className="space-y-6">
      <section>
        <h2 className="font-mono text-xs uppercase tracking-wide text-muted">Background</h2>
        <p className="mt-2 max-w-lg text-sm text-muted">
          Upload images here and they appear immediately. JPEG, PNG, WebP or AVIF — each is
          re-encoded to WebP, scaled down to 4K if larger, and stripped of camera metadata.
        </p>
        <p className="mt-2 max-w-lg text-xs text-muted">
          Any size is accepted. Images are scaled to fill the screen, so smaller ones still work —
          they just look softer. Around 1600px wide or more stays sharp on a large display.
        </p>
      </section>

      {/* Uploader --------------------------------------------------------- */}
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          void upload(pickImages(e.dataTransfer.files))
        }}
        className={`card flex flex-col items-center border-dashed p-8 text-center transition-colors ${
          dragging ? 'border-accent bg-accent/5' : ''
        }`}
      >
        {queue ? (
          <>
            <Loader2 size={22} className="animate-spin text-accent" />
            <p className="mt-3 font-mono text-xs text-muted">
              uploading {queue.done + 1} of {queue.total}
            </p>
          </>
        ) : (
          <>
            <Upload size={22} className="text-muted" />
            <p className="mt-3 text-sm">Drop images here</p>
            <button onClick={() => fileRef.current?.click()} className="btn-ghost mt-3 text-xs">
              or choose files
            </button>
          </>
        )}

        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/avif"
          multiple
          className="hidden"
          onChange={(e) => {
            void upload(pickImages(e.target.files))
            e.target.value = ''
          }}
        />
      </div>

      {error && (
        <p className="whitespace-pre-wrap border-l-2 border-danger pl-3 text-sm text-danger">
          {error}
        </p>
      )}

      {warnings.map((w) => (
        <p key={w} className="border-l-2 border-warn pl-3 text-sm text-warn">
          {w}
        </p>
      ))}

      {/* Mode ------------------------------------------------------------- */}
      <button
        onClick={() => apply({ mode: 'daily' })}
        className={`card flex w-full items-center gap-3 p-4 text-left transition-colors ${
          isDaily ? 'border-accent' : 'hover:border-muted'
        }`}
      >
        <Shuffle size={16} className={isDaily ? 'text-accent' : 'text-muted'} />
        <span className="flex-1">
          <span className="block text-sm">Rotate daily</span>
          <span className="block font-mono text-[11px] text-muted">
            one image per day, chosen from all {backgrounds.length}, changing at midnight
          </span>
        </span>
        {busy === 'daily' ? (
          <Loader2 size={15} className="animate-spin text-muted" />
        ) : (
          isDaily && <Check size={16} className="text-accent" />
        )}
      </button>

      {/* Grid ------------------------------------------------------------- */}
      {backgrounds.length === 0 ? (
        <div className="card flex flex-col items-center p-12 text-center">
          <ImageIcon size={26} className="text-muted" />
          <p className="mt-3 font-mono text-xs text-muted">no backgrounds yet</p>
        </div>
      ) : (
        <div>
          <h3 className="mb-3 font-mono text-xs uppercase tracking-wide text-muted">
            or pin one ({backgrounds.length} available
            {uploaded > 0 && `, ${uploaded} uploaded`})
          </h3>

          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {backgrounds.map((bg) => {
              const active = mode.mode === 'fixed' && mode.file === bg.url
              const isBusy = busy === bg.url

              return (
                <div
                  key={bg.url}
                  className={`group relative overflow-hidden rounded-card border transition-colors ${
                    active ? 'border-accent' : 'border-border hover:border-muted'
                  }`}
                >
                  <button
                    onClick={() => apply({ mode: 'fixed', file: bg.url })}
                    className="block w-full"
                    title={`Pin ${bg.name}`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={bg.url}
                      alt=""
                      loading="lazy"
                      className="h-28 w-full object-cover transition-transform group-hover:scale-[1.03]"
                    />
                  </button>

                  <span className="absolute inset-x-0 bottom-0 flex items-center gap-1 bg-bg/85 px-2 py-1 font-mono text-[10px] text-muted">
                    <span className="min-w-0 flex-1 truncate" title={bg.name}>
                      {bg.name}
                    </span>
                    <span className="shrink-0 opacity-70">{formatBytes(bg.bytes)}</span>
                  </span>

                  {/* Built-in images live in the repo, so a delete here would
                      be undone by the next deploy. Marked rather than offered. */}
                  {bg.source === 'builtin' ? (
                    <span
                      className="absolute left-2 top-2 rounded bg-bg/85 p-1 text-muted"
                      title="Ships with the site — remove it from public/backgrounds/ in the repo"
                    >
                      <Lock size={11} />
                    </span>
                  ) : (
                    <button
                      onClick={() => remove(bg)}
                      disabled={isBusy}
                      className="absolute left-2 top-2 rounded bg-bg/85 p-1 text-muted opacity-0 transition-opacity hover:text-danger focus:opacity-100 group-hover:opacity-100"
                      title={`Delete ${bg.name}`}
                      aria-label={`Delete ${bg.name}`}
                    >
                      <Trash2 size={11} />
                    </button>
                  )}

                  {isBusy && (
                    <span className="absolute inset-0 flex items-center justify-center bg-bg/70">
                      <Loader2 size={18} className="animate-spin text-accent" />
                    </span>
                  )}

                  {active && !isBusy && (
                    <span className="absolute right-2 top-2 rounded-full bg-accent p-1">
                      <Check size={12} className="text-accent-fg" />
                    </span>
                  )}
                </div>
              )
            })}
          </div>

          <p className="mt-3 font-mono text-[10px] text-muted">
            <Lock size={9} className="inline" /> marks images that ship with the site. uploaded ones
            can be deleted here.
          </p>
        </div>
      )}
    </div>
  )
}
