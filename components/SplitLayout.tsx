import { dailyBackground } from '@/lib/backgrounds'
import { Snow } from './Background'

/**
 * Split composition: solid content panel on the left, photograph on the right.
 *
 * The previous version laid content over a full-bleed photo dimmed to ~14%
 * visibility, which wasted the photograph and left the page looking like a
 * generic dark template. Giving the image its own half means it can be shown
 * at full strength — it becomes the thing carrying the visual weight, and the
 * text sits on a solid panel where contrast is never in question.
 *
 * The photo half is hidden below `lg`, where there isn't room for two columns.
 */
export function SplitLayout({
  children,
  reverse = false,
}: {
  children: React.ReactNode
  reverse?: boolean
}) {
  const src = dailyBackground()

  return (
    <div className="flex min-h-screen">
      <div
        className={`flex min-h-screen w-full flex-col bg-bg lg:w-[46%] ${
          reverse ? 'lg:order-2' : ''
        }`}
      >
        {children}
      </div>

      {src && (
        <div
          className={`relative hidden min-h-screen flex-1 overflow-hidden lg:block ${
            reverse ? 'lg:order-1' : ''
          }`}
        >
          <div
            className="absolute inset-0 bg-cover bg-center"
            style={{ backgroundImage: `url(${src})` }}
          />
          {/* Barely there — just enough to stop white snow blowing out next to
              the dark panel, nowhere near enough to hide the picture. */}
          <div className="absolute inset-0 bg-bg/[0.12]" />
          <Snow />
        </div>
      )}
    </div>
  )
}
