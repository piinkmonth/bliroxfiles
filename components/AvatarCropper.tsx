'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ZoomIn, RotateCw, Check, X, Loader2 } from 'lucide-react'

/** Output size. Matches the server's re-encode, so no quality is lost twice. */
const OUTPUT_PX = 256
/** On-screen editor size. */
const VIEW_PX = 280

interface Transform {
  scale: number
  /** Offset of the image centre from the viewport centre, in screen pixels. */
  x: number
  y: number
  /** Quarter turns. */
  rotation: number
}

/**
 * Drag-and-zoom avatar cropper.
 *
 * Works in screen space and only converts to image space at export time, which
 * keeps the maths for dragging and clamping simple. The image is constrained so
 * it always covers the crop circle — there is no way to position it such that
 * the output would contain transparent corners.
 */
export function AvatarCropper({
  file,
  onCancel,
  onCropped,
}: {
  file: File
  onCancel: () => void
  onCropped: (blob: Blob) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [t, setT] = useState<Transform>({ scale: 1, x: 0, y: 0, rotation: 0 })

  // Pointer state lives in a ref: updating it must not trigger a re-render.
  const drag = useRef<{ id: number; startX: number; startY: number; origX: number; origY: number } | null>(null)
  const pinch = useRef<Map<number, { x: number; y: number }>>(new Map())
  const pinchStart = useRef<{ dist: number; scale: number } | null>(null)

  // --- load ----------------------------------------------------------------
  useEffect(() => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      imageRef.current = img
      // Start at the scale that exactly covers the circle.
      setT({ scale: 1, x: 0, y: 0, rotation: 0 })
      setReady(true)
    }
    img.onerror = () => setError('That image could not be read')
    img.src = url
    return () => URL.revokeObjectURL(url)
  }, [file])

  /**
   * Scale at which the image exactly covers the viewport. Everything else is
   * expressed as a multiple of this, so `scale: 1` always means "just covers"
   * regardless of the source image's aspect ratio.
   */
  const baseScale = useCallback(() => {
    const img = imageRef.current
    if (!img) return 1
    const swapped = t.rotation % 2 === 1
    const w = swapped ? img.naturalHeight : img.naturalWidth
    const h = swapped ? img.naturalWidth : img.naturalHeight
    return Math.max(VIEW_PX / w, VIEW_PX / h)
  }, [t.rotation])

  /** Keep the image covering the viewport at all times. */
  const clamp = useCallback(
    (next: Transform): Transform => {
      const img = imageRef.current
      if (!img) return next

      const scale = Math.max(1, Math.min(next.scale, 8))
      const swapped = next.rotation % 2 === 1
      const w = (swapped ? img.naturalHeight : img.naturalWidth) * baseScale() * scale
      const h = (swapped ? img.naturalWidth : img.naturalHeight) * baseScale() * scale

      // Half the overhang in each axis is the furthest the centre may move.
      const maxX = Math.max(0, (w - VIEW_PX) / 2)
      const maxY = Math.max(0, (h - VIEW_PX) / 2)

      return {
        scale,
        rotation: next.rotation,
        x: Math.max(-maxX, Math.min(maxX, next.x)),
        y: Math.max(-maxY, Math.min(maxY, next.y)),
      }
    },
    [baseScale],
  )

  // --- render --------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current
    const img = imageRef.current
    if (!canvas || !img || !ready) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = VIEW_PX * dpr
    canvas.height = VIEW_PX * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    ctx.clearRect(0, 0, VIEW_PX, VIEW_PX)

    ctx.save()
    ctx.translate(VIEW_PX / 2 + t.x, VIEW_PX / 2 + t.y)
    ctx.rotate((t.rotation * Math.PI) / 2)
    const s = baseScale() * t.scale
    ctx.drawImage(
      img,
      (-img.naturalWidth * s) / 2,
      (-img.naturalHeight * s) / 2,
      img.naturalWidth * s,
      img.naturalHeight * s,
    )
    ctx.restore()

    // Dim everything outside the crop circle.
    ctx.save()
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.beginPath()
    ctx.rect(0, 0, VIEW_PX, VIEW_PX)
    ctx.arc(VIEW_PX / 2, VIEW_PX / 2, VIEW_PX / 2 - 1, 0, Math.PI * 2, true)
    ctx.fill()

    ctx.strokeStyle = 'rgba(255,255,255,0.8)'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.arc(VIEW_PX / 2, VIEW_PX / 2, VIEW_PX / 2 - 1, 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
  }, [t, ready, baseScale])

  // --- interaction ---------------------------------------------------------
  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    pinch.current.set(e.pointerId, { x: e.clientX, y: e.clientY })

    if (pinch.current.size === 2) {
      const [a, b] = [...pinch.current.values()]
      pinchStart.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), scale: t.scale }
      drag.current = null
    } else {
      drag.current = {
        id: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        origX: t.x,
        origY: t.y,
      }
    }
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!pinch.current.has(e.pointerId)) return
    pinch.current.set(e.pointerId, { x: e.clientX, y: e.clientY })

    if (pinch.current.size === 2 && pinchStart.current) {
      const [a, b] = [...pinch.current.values()]
      const dist = Math.hypot(a.x - b.x, a.y - b.y)
      const ratio = dist / pinchStart.current.dist
      setT((prev) => clamp({ ...prev, scale: pinchStart.current!.scale * ratio }))
      return
    }

    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    setT((prev) =>
      clamp({ ...prev, x: d.origX + (e.clientX - d.startX), y: d.origY + (e.clientY - d.startY) }),
    )
  }

  function onPointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    pinch.current.delete(e.pointerId)
    if (pinch.current.size < 2) pinchStart.current = null
    if (drag.current?.id === e.pointerId) drag.current = null
  }

  function onWheel(e: React.WheelEvent<HTMLCanvasElement>) {
    // Not preventDefault: React attaches wheel passively, so the page would
    // scroll too. `overscroll-contain` + touch-action on the element handles it.
    setT((prev) => clamp({ ...prev, scale: prev.scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12) }))
  }

  // --- export --------------------------------------------------------------
  async function apply() {
    const img = imageRef.current
    if (!img) return
    setBusy(true)

    try {
      const out = document.createElement('canvas')
      out.width = OUTPUT_PX
      out.height = OUTPUT_PX
      const ctx = out.getContext('2d')
      if (!ctx) throw new Error('Canvas unavailable')

      // Same composition as the preview, scaled from the viewport to the
      // output size — so what the user positioned is exactly what is saved.
      const k = OUTPUT_PX / VIEW_PX
      ctx.save()
      ctx.translate(OUTPUT_PX / 2 + t.x * k, OUTPUT_PX / 2 + t.y * k)
      ctx.rotate((t.rotation * Math.PI) / 2)
      const s = baseScale() * t.scale * k
      ctx.drawImage(
        img,
        (-img.naturalWidth * s) / 2,
        (-img.naturalHeight * s) / 2,
        img.naturalWidth * s,
        img.naturalHeight * s,
      )
      ctx.restore()

      const blob = await new Promise<Blob | null>((resolve) =>
        out.toBlob(resolve, 'image/webp', 0.9),
      )
      if (!blob) throw new Error('Could not produce an image')
      onCropped(blob)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Crop failed')
      setBusy(false)
    }
  }

  return (
    <div className="card p-5">
      <h3 className="font-mono text-xs uppercase tracking-wide text-muted">
        Position your picture
      </h3>

      {error ? (
        <p className="mt-3 border-l-2 border-danger pl-3 text-sm text-danger">{error}</p>
      ) : (
        <>
          <div className="mt-4 flex justify-center">
            <canvas
              ref={canvasRef}
              style={{ width: VIEW_PX, height: VIEW_PX, touchAction: 'none' }}
              className="cursor-grab overscroll-contain rounded bg-raised active:cursor-grabbing"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onWheel={onWheel}
            />
          </div>

          <p className="mt-3 text-center font-mono text-[11px] text-muted">
            drag to move · scroll or pinch to zoom
          </p>

          <div className="mt-4 flex items-center gap-3">
            <ZoomIn size={14} className="shrink-0 text-muted" />
            <input
              type="range"
              min={1}
              max={8}
              step={0.02}
              value={t.scale}
              onChange={(e) => setT((prev) => clamp({ ...prev, scale: Number(e.target.value) }))}
              className="flex-1 accent-[rgb(var(--c-accent))]"
              aria-label="Zoom"
            />
            <button
              onClick={() => setT((prev) => clamp({ ...prev, rotation: (prev.rotation + 1) % 4 }))}
              className="btn-ghost shrink-0"
              title="Rotate 90°"
            >
              <RotateCw size={14} />
            </button>
          </div>

          <div className="mt-4 flex gap-2">
            <button onClick={apply} className="btn-primary flex-1" disabled={busy || !ready}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
              Use this
            </button>
            <button onClick={onCancel} className="btn-ghost" disabled={busy}>
              <X size={14} />
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  )
}
