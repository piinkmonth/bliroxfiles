'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Play, Pause, Volume2, VolumeX, Maximize, Minimize,
  PictureInPicture2, Loader2, RotateCcw,
} from 'lucide-react'

/**
 * Video and audio player.
 *
 * Native controls are replaced rather than restyled because they cannot be
 * restyled — every browser draws its own and none of them can be reached from
 * CSS. Since this page is otherwise a deliberate mono-and-hairlines design, a
 * stock Chrome control bar in the middle of it is the one element that looks
 * borrowed.
 *
 * What that obliges the replacement to put back, since it is all free with the
 * native controls and all absent without them:
 *
 * - **Keyboard.** Space and K toggle, arrows seek and change volume, J and L
 *   jump ten seconds, F fullscreens, M mutes, 0-9 seek to a percentage.
 *   Handled on the container, which holds focus, so the shortcuts do not fire
 *   while someone is typing in the password box further up the page.
 * - **Buffered ranges**, drawn behind the progress bar. Without them a stalled
 *   download and a slow one look identical.
 * - **Accessible state.** The scrubber is a real slider with the ARIA value
 *   properties kept current, so it is operable without a pointer.
 *
 * Everything is driven off media events rather than a timer, so the UI cannot
 * drift out of step with what is actually playing.
 */

function clockTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  // Hours only appear once there are any — "0:04:12" for a four-minute clip
  // is noise.
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}

const SPEEDS = [0.5, 1, 1.25, 1.5, 2]

export function MediaPlayer({
  src,
  kind,
  poster,
  title,
}: {
  src: string
  kind: 'video' | 'audio'
  poster?: string | null
  title?: string
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const mediaRef = useRef<HTMLVideoElement & HTMLAudioElement>(null)

  const [playing, setPlaying] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [ended, setEnded] = useState(false)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(0)
  const [buffered, setBuffered] = useState(0)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [failed, setFailed] = useState(false)
  /*
   * Resolved in an effect rather than read during render.
   *
   * `document` does not exist on the server, and optional chaining does not
   * help — `document?.x` still throws a ReferenceError for an identifier that
   * was never declared, which takes the whole server render down with it.
   * Starting false and enabling after mount also keeps the first client render
   * identical to the server's, so there is no hydration mismatch.
   */
  const [pipSupported, setPipSupported] = useState(false)
  // Controls hide during playback on video, and never on audio.
  const [idle, setIdle] = useState(false)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const isVideo = kind === 'video'

  // --- transport ------------------------------------------------------------

  const toggle = useCallback(() => {
    const el = mediaRef.current
    if (!el) return
    if (el.paused) void el.play().catch(() => setFailed(true))
    else el.pause()
  }, [])

  const seekBy = useCallback((delta: number) => {
    const el = mediaRef.current
    if (!el || !Number.isFinite(el.duration)) return
    el.currentTime = Math.min(Math.max(0, el.currentTime + delta), el.duration)
  }, [])

  const seekTo = useCallback((fraction: number) => {
    const el = mediaRef.current
    if (!el || !Number.isFinite(el.duration)) return
    el.currentTime = Math.min(Math.max(0, fraction * el.duration), el.duration)
  }, [])

  const changeVolume = useCallback((next: number) => {
    const el = mediaRef.current
    if (!el) return
    const v = Math.min(1, Math.max(0, next))
    el.volume = v
    el.muted = v === 0
  }, [])

  // --- wiring ---------------------------------------------------------------

  useEffect(() => {
    const el = mediaRef.current
    if (!el) return

    const onTime = () => setCurrent(el.currentTime)
    const onDuration = () => setDuration(Number.isFinite(el.duration) ? el.duration : 0)
    const onPlay = () => {
      setPlaying(true)
      setEnded(false)
    }
    const onPause = () => setPlaying(false)
    const onEnded = () => {
      setPlaying(false)
      setEnded(true)
      setIdle(false)
    }
    const onWaiting = () => setWaiting(true)
    const onPlaying = () => setWaiting(false)
    const onVolume = () => {
      setVolume(el.volume)
      setMuted(el.muted)
    }
    const onRate = () => setSpeed(el.playbackRate)
    const onError = () => setFailed(true)
    const onProgress = () => {
      // Only the range containing the playhead matters — a gap further along
      // is not something the viewer is waiting on.
      const ranges = el.buffered
      for (let i = 0; i < ranges.length; i++) {
        if (ranges.start(i) <= el.currentTime && el.currentTime <= ranges.end(i)) {
          setBuffered(ranges.end(i))
          return
        }
      }
    }

    el.addEventListener('timeupdate', onTime)
    el.addEventListener('durationchange', onDuration)
    el.addEventListener('loadedmetadata', onDuration)
    el.addEventListener('play', onPlay)
    el.addEventListener('pause', onPause)
    el.addEventListener('ended', onEnded)
    el.addEventListener('waiting', onWaiting)
    el.addEventListener('playing', onPlaying)
    el.addEventListener('volumechange', onVolume)
    el.addEventListener('ratechange', onRate)
    el.addEventListener('progress', onProgress)
    el.addEventListener('error', onError)

    return () => {
      el.removeEventListener('timeupdate', onTime)
      el.removeEventListener('durationchange', onDuration)
      el.removeEventListener('loadedmetadata', onDuration)
      el.removeEventListener('play', onPlay)
      el.removeEventListener('pause', onPause)
      el.removeEventListener('ended', onEnded)
      el.removeEventListener('waiting', onWaiting)
      el.removeEventListener('playing', onPlaying)
      el.removeEventListener('volumechange', onVolume)
      el.removeEventListener('ratechange', onRate)
      el.removeEventListener('progress', onProgress)
      el.removeEventListener('error', onError)
    }
  }, [])

  useEffect(() => {
    setPipSupported(!!document.pictureInPictureEnabled)
    const onChange = () => setFullscreen(document.fullscreenElement === wrapRef.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  // --- keyboard -------------------------------------------------------------

  function onKeyDown(e: React.KeyboardEvent) {
    // Never swallow a modified key — ctrl+F is find, not fullscreen.
    if (e.ctrlKey || e.metaKey || e.altKey) return

    const handled = () => {
      e.preventDefault()
      e.stopPropagation()
      setIdle(false)
    }

    switch (e.key) {
      case ' ':
      case 'k':
        handled()
        toggle()
        break
      case 'ArrowRight':
        handled()
        seekBy(5)
        break
      case 'ArrowLeft':
        handled()
        seekBy(-5)
        break
      case 'l':
        handled()
        seekBy(10)
        break
      case 'j':
        handled()
        seekBy(-10)
        break
      case 'ArrowUp':
        handled()
        changeVolume(volume + 0.1)
        break
      case 'ArrowDown':
        handled()
        changeVolume(volume - 0.1)
        break
      case 'm':
        handled()
        if (mediaRef.current) mediaRef.current.muted = !muted
        break
      case 'f':
        if (!isVideo) return
        handled()
        void toggleFullscreen()
        break
      case 'Home':
        handled()
        seekTo(0)
        break
      case 'End':
        handled()
        seekTo(1)
        break
      default:
        if (/^[0-9]$/.test(e.key)) {
          handled()
          seekTo(Number(e.key) / 10)
        }
    }
  }

  async function toggleFullscreen() {
    if (!wrapRef.current) return
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await wrapRef.current.requestFullscreen()
    } catch {
      // Refused (iOS Safari on non-video elements, permissions policy) — the
      // player keeps working inline, so there is nothing to report.
    }
  }

  async function togglePip() {
    const el = mediaRef.current
    if (!el || !document.pictureInPictureEnabled) return
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture()
      else await el.requestPictureInPicture()
    } catch {
      /* unsupported or refused */
    }
  }

  function nudgeIdle() {
    setIdle(false)
    if (idleTimer.current) clearTimeout(idleTimer.current)
    if (!isVideo) return
    idleTimer.current = setTimeout(() => {
      if (mediaRef.current && !mediaRef.current.paused) setIdle(true)
    }, 2400)
  }

  useEffect(() => () => { if (idleTimer.current) clearTimeout(idleTimer.current) }, [])

  // --- scrubbing ------------------------------------------------------------

  const scrubRef = useRef<HTMLDivElement>(null)

  function scrubFromPointer(clientX: number) {
    const box = scrubRef.current?.getBoundingClientRect()
    if (!box || box.width === 0) return
    seekTo((clientX - box.left) / box.width)
  }

  function onScrubPointerDown(e: React.PointerEvent) {
    e.currentTarget.setPointerCapture(e.pointerId)
    scrubFromPointer(e.clientX)
  }

  function onScrubPointerMove(e: React.PointerEvent) {
    // buttons is a bitmask; 1 is the primary button being held.
    if (e.buttons & 1) scrubFromPointer(e.clientX)
  }

  if (failed) {
    return (
      <div className="border border-border bg-raised/40 p-4 text-center">
        <p className="font-mono text-[11px] text-muted">
          this {kind} could not be played here — download it instead
        </p>
      </div>
    )
  }

  const progress = duration > 0 ? current / duration : 0
  const bufferedFraction = duration > 0 ? Math.min(1, buffered / duration) : 0
  const controlsHidden = isVideo && idle && playing

  return (
    <div
      ref={wrapRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerMove={nudgeIdle}
      onPointerLeave={() => isVideo && playing && setIdle(true)}
      className={`group relative select-none overflow-hidden border border-border bg-black outline-none focus-visible:border-accent ${
        isVideo ? '' : 'bg-raised/40'
      } ${controlsHidden ? 'cursor-none' : ''}`}
      aria-label={title ? `${kind} player: ${title}` : `${kind} player`}
    >
      {isVideo ? (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video
          ref={mediaRef}
          src={src}
          poster={poster ?? undefined}
          preload="metadata"
          playsInline
          onClick={toggle}
          onDoubleClick={toggleFullscreen}
          className="block max-h-[70vh] w-full cursor-pointer bg-black"
        />
      ) : (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <audio ref={mediaRef} src={src} preload="metadata" className="hidden" />
      )}

      {/* Centre affordance — only for video, and only when it says something
          the control bar does not. */}
      {isVideo && (!playing || waiting || ended) && (
        <button
          onClick={ended ? () => { seekTo(0); toggle() } : toggle}
          className="absolute inset-0 flex items-center justify-center bg-black/25 transition-colors hover:bg-black/35"
          aria-label={ended ? 'Replay' : playing ? 'Pause' : 'Play'}
        >
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-black/70 text-white backdrop-blur">
            {waiting ? (
              <Loader2 size={22} className="animate-spin" />
            ) : ended ? (
              <RotateCcw size={22} />
            ) : (
              <Play size={22} className="ml-0.5" fill="currentColor" />
            )}
          </span>
        </button>
      )}

      {/* Control bar */}
      <div
        className={`${
          isVideo
            ? 'absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/55 to-transparent pt-8 text-white'
            : 'relative text-text'
        } px-2.5 pb-2 transition-opacity duration-200 ${
          controlsHidden ? 'pointer-events-none opacity-0' : 'opacity-100'
        }`}
      >
        {/* Scrubber */}
        <div
          ref={scrubRef}
          role="slider"
          tabIndex={-1}
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(current)}
          aria-valuetext={`${clockTime(current)} of ${clockTime(duration)}`}
          onPointerDown={onScrubPointerDown}
          onPointerMove={onScrubPointerMove}
          className="group/scrub relative flex h-4 cursor-pointer items-center"
        >
          <div className={`h-1 w-full ${isVideo ? 'bg-white/25' : 'bg-border'}`}>
            <div
              className={`h-full ${isVideo ? 'bg-white/30' : 'bg-muted/40'}`}
              style={{ width: `${bufferedFraction * 100}%` }}
            />
          </div>
          <div
            className="absolute left-0 h-1 bg-[rgb(var(--c-accent))]"
            style={{ width: `${progress * 100}%` }}
          />
          <div
            className="absolute h-2.5 w-2.5 -translate-x-1/2 rounded-full bg-[rgb(var(--c-accent))] opacity-0 transition-opacity group-hover/scrub:opacity-100"
            style={{ left: `${progress * 100}%` }}
          />
        </div>

        <div className="flex items-center gap-1 pt-1">
          <IconButton onClick={toggle} label={playing ? 'Pause' : 'Play'}>
            {playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}
          </IconButton>

          {/* Volume: the slider expands on hover so the bar stays compact. */}
          <div className="group/vol flex items-center">
            <IconButton
              onClick={() => mediaRef.current && (mediaRef.current.muted = !muted)}
              label={muted ? 'Unmute' : 'Mute'}
            >
              {muted || volume === 0 ? <VolumeX size={15} /> : <Volume2 size={15} />}
            </IconButton>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              onChange={(e) => changeVolume(Number(e.target.value))}
              aria-label="Volume"
              className="h-1 w-0 cursor-pointer accent-[rgb(var(--c-accent))] opacity-0 transition-all duration-200 group-hover/vol:w-16 group-hover/vol:opacity-100 focus:w-16 focus:opacity-100"
            />
          </div>

          <span className="ml-1 font-mono text-[11px] tabular-nums opacity-80">
            {clockTime(current)}
            <span className="opacity-50"> / {clockTime(duration)}</span>
          </span>

          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={() => {
                const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]
                if (mediaRef.current) mediaRef.current.playbackRate = next
              }}
              className="rounded px-1.5 py-1 font-mono text-[11px] tabular-nums opacity-80 transition-opacity hover:opacity-100"
              aria-label={`Playback speed, currently ${speed}x`}
            >
              {speed}×
            </button>

            {isVideo && pipSupported && (
              <IconButton onClick={togglePip} label="Picture in picture">
                <PictureInPicture2 size={15} />
              </IconButton>
            )}

            {isVideo && (
              <IconButton
                onClick={toggleFullscreen}
                label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              >
                {fullscreen ? <Minimize size={15} /> : <Maximize size={15} />}
              </IconButton>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function IconButton({
  children,
  onClick,
  label,
}: {
  children: React.ReactNode
  onClick: () => void
  label: string
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className="rounded p-1.5 opacity-80 transition-opacity hover:opacity-100"
    >
      {children}
    </button>
  )
}
