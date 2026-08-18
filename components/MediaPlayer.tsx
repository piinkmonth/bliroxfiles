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

/*
 * Fullscreen, unprefixed, is in every browser this app supports except Safari,
 * which still ships only `webkit*` — and on iPhone ships no element fullscreen
 * at all, only `webkitEnterFullscreen` on the video itself. None of the three
 * are in the DOM lib types, hence the casts.
 */
type FsDocument = Document & {
  webkitFullscreenElement?: Element | null
  webkitExitFullscreen?: () => Promise<void> | void
}
type FsElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void }
type IosVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void }

function fullscreenElement(): Element | null {
  const d = document as FsDocument
  return d.fullscreenElement ?? d.webkitFullscreenElement ?? null
}

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
    const onChange = () => {
      const inside = fullscreenElement() === wrapRef.current
      setFullscreen(inside)
      // Escape leaves fullscreen without moving the pointer, so the idle timer
      // would otherwise drop us back inline with the controls still hidden.
      if (!inside) setIdle(false)
    }
    document.addEventListener('fullscreenchange', onChange)
    document.addEventListener('webkitfullscreenchange', onChange)
    return () => {
      document.removeEventListener('fullscreenchange', onChange)
      document.removeEventListener('webkitfullscreenchange', onChange)
    }
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
    const wrap = wrapRef.current as FsElement | null
    if (!wrap) return
    const d = document as FsDocument
    try {
      if (fullscreenElement()) {
        if (d.exitFullscreen) await d.exitFullscreen()
        else d.webkitExitFullscreen?.()
        return
      }
      if (wrap.requestFullscreen) await wrap.requestFullscreen()
      else if (wrap.webkitRequestFullscreen) await wrap.webkitRequestFullscreen()
      // iPhone: no element fullscreen, so hand the video to the native player.
      else (mediaRef.current as IosVideo | null)?.webkitEnterFullscreen?.()
      // The shortcuts are bound to the wrapper, and some browsers move focus to
      // the fullscreen root's document instead — without this, F and space stop
      // responding the moment the screen fills.
      wrap.focus()
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
  /*
   * Fullscreen is a different layout, not the inline one stretched.
   *
   * The inline player is a fixed-width card: the video caps at 70vh and the
   * wrapper hugs it. Fullscreen makes the wrapper the size of the screen, so
   * that cap becomes a video pinned to the top of the display with a black band
   * under it, inside a hairline border tracing the bezel. So fullscreen drops
   * the border, centres its contents, and lets the video take the whole area at
   * its own aspect ratio.
   *
   * The controls scale with it. 11px text and 15px icons are right at 512px
   * wide and unreadable across 1080p, and every native player grows them here.
   */
  const inFs = fullscreen && isVideo
  const ic = inFs ? 19 : 15

  return (
    <div
      ref={wrapRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerMove={nudgeIdle}
      onPointerLeave={() => isVideo && playing && setIdle(true)}
      className={`group relative select-none overflow-hidden outline-none ${
        inFs
          ? 'flex h-full w-full items-center justify-center bg-black'
          : `border border-border focus-visible:border-accent ${isVideo ? 'bg-black' : 'bg-raised/40'}`
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
          className={`block w-full cursor-pointer bg-black ${
            inFs ? 'h-full max-h-none object-contain' : 'max-h-[70vh]'
          }`}
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
          <span
            className={`flex items-center justify-center rounded-full bg-black/70 text-white backdrop-blur ${
              inFs ? 'h-20 w-20' : 'h-14 w-14'
            }`}
          >
            {waiting ? (
              <Loader2 size={inFs ? 30 : 22} className="animate-spin" />
            ) : ended ? (
              <RotateCcw size={inFs ? 30 : 22} />
            ) : (
              <Play size={inFs ? 30 : 22} className="ml-0.5" fill="currentColor" />
            )}
          </span>
        </button>
      )}

      {/* Control bar */}
      <div
        className={`${
          isVideo
            ? `absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/55 to-transparent text-white ${
                inFs ? 'pt-16' : 'pt-8'
              }`
            : 'relative text-text'
        } ${inFs ? 'px-5 pb-4' : 'px-2.5 pb-2'} transition-opacity duration-200 ${
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
          className={`group/scrub relative flex cursor-pointer items-center ${
            inFs ? 'h-6' : 'h-4'
          }`}
        >
          <div
            className={`w-full ${inFs ? 'h-1.5' : 'h-1'} ${isVideo ? 'bg-white/25' : 'bg-border'}`}
          >
            <div
              className={`h-full ${isVideo ? 'bg-white/30' : 'bg-muted/40'}`}
              style={{ width: `${bufferedFraction * 100}%` }}
            />
          </div>
          <div
            className={`absolute left-0 bg-[rgb(var(--c-accent))] ${inFs ? 'h-1.5' : 'h-1'}`}
            style={{ width: `${progress * 100}%` }}
          />
          <div
            className={`absolute -translate-x-1/2 rounded-full bg-[rgb(var(--c-accent))] opacity-0 transition-opacity group-hover/scrub:opacity-100 ${
              inFs ? 'h-4 w-4' : 'h-2.5 w-2.5'
            }`}
            style={{ left: `${progress * 100}%` }}
          />
        </div>

        <div className={`flex items-center pt-1 ${inFs ? 'gap-2' : 'gap-1'}`}>
          <IconButton onClick={toggle} label={playing ? 'Pause' : 'Play'} big={inFs}>
            {playing ? <Pause size={ic} fill="currentColor" /> : <Play size={ic} fill="currentColor" />}
          </IconButton>

          {/* Volume: the slider expands on hover so the bar stays compact. */}
          <div className="group/vol flex items-center">
            <IconButton
              onClick={() => mediaRef.current && (mediaRef.current.muted = !muted)}
              label={muted ? 'Unmute' : 'Mute'}
              big={inFs}
            >
              {muted || volume === 0 ? <VolumeX size={ic} /> : <Volume2 size={ic} />}
            </IconButton>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              onChange={(e) => changeVolume(Number(e.target.value))}
              aria-label="Volume"
              className={`h-1 w-0 cursor-pointer accent-[rgb(var(--c-accent))] opacity-0 transition-all duration-200 ${
                inFs
                  ? 'focus:w-24 focus:opacity-100 group-hover/vol:w-24 group-hover/vol:opacity-100'
                  : 'focus:w-16 focus:opacity-100 group-hover/vol:w-16 group-hover/vol:opacity-100'
              }`}
            />
          </div>

          <span
            className={`ml-1 font-mono tabular-nums opacity-80 ${inFs ? 'text-[13px]' : 'text-[11px]'}`}
          >
            {clockTime(current)}
            <span className="opacity-50"> / {clockTime(duration)}</span>
          </span>

          <div className={`ml-auto flex items-center ${inFs ? 'gap-2' : 'gap-1'}`}>
            <button
              onClick={() => {
                const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]
                if (mediaRef.current) mediaRef.current.playbackRate = next
              }}
              className={`rounded font-mono tabular-nums opacity-80 transition-opacity hover:opacity-100 ${
                inFs ? 'px-2 py-1.5 text-[13px]' : 'px-1.5 py-1 text-[11px]'
              }`}
              aria-label={`Playback speed, currently ${speed}x`}
            >
              {speed}×
            </button>

            {isVideo && pipSupported && (
              <IconButton onClick={togglePip} label="Picture in picture" big={inFs}>
                <PictureInPicture2 size={ic} />
              </IconButton>
            )}

            {isVideo && (
              <IconButton
                onClick={toggleFullscreen}
                label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                big={inFs}
              >
                {fullscreen ? <Minimize size={ic} /> : <Maximize size={ic} />}
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
  big,
}: {
  children: React.ReactNode
  onClick: () => void
  label: string
  big?: boolean
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`rounded opacity-80 transition-opacity hover:opacity-100 ${big ? 'p-2' : 'p-1.5'}`}
    >
      {children}
    </button>
  )
}
