import { dailyBackground } from '@/lib/backgrounds'

/**
 * Fixed background image with a readability scrim.
 *
 * The scrim is not optional. The photo set ranges from blown-out white snow to
 * a dark blue twilight scene, so any fixed text colour is unreadable on one
 * end or the other. Layering a theme-coloured wash over the photo pins the
 * effective contrast regardless of which image came up.
 */
export function Background({ intensity = 'normal' }: { intensity?: 'normal' | 'strong' }) {
  const src = dailyBackground()
  if (!src) return null

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div
        className="absolute inset-0 bg-cover bg-center bg-no-repeat"
        style={{ backgroundImage: `url(${src})` }}
      />

      {/*
       * Flat wash in the theme's background colour — no gradient. One even
       * layer keeps contrast identical at the top and bottom of the page,
       * which a vertical fade does not, and avoids the gradient-over-photo
       * look entirely.
       */}
      <div
        className={`absolute inset-0 bg-bg ${
          intensity === 'strong' ? 'opacity-[0.93]' : 'opacity-[0.86]'
        }`}
      />

      {/* Desaturate the photo so the warm accent is the only colour on screen. */}
      <div className="absolute inset-0 backdrop-saturate-[0.35]" />

      <Snow />
    </div>
  )
}

/** Three parallax layers of falling snow. See globals.css — no JS involved. */
export function Snow() {
  return (
    <div className="absolute inset-0 overflow-hidden">
      <div className="snow-layer snow-layer-1" />
      <div className="snow-layer snow-layer-2" />
      <div className="snow-layer snow-layer-3" />
    </div>
  )
}
