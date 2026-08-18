import { LOGO_SRC } from '@/lib/branding'
import { LogoMark } from './LogoMark'

export { LogoMark }

/**
 * The Blirox mark, for server components.
 *
 * Renders public/logo.svg|png|webp when one exists, otherwise falls back to the
 * built-in letterform so nothing is ever blank. See lib/branding.ts.
 *
 * Client components cannot use this — branding.ts reads the filesystem. They
 * take the resolved path as a prop instead (see Nav).
 */
export function Logo({ size = 26, className = '' }: { size?: number; className?: string }) {
  if (!LOGO_SRC) return <LogoMark size={size} className={className} />

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={LOGO_SRC}
      alt="blirox"
      width={size}
      height={size}
      className={`shrink-0 object-contain ${className}`}
      style={{ width: size, height: size }}
    />
  )
}

/** Mark plus wordmark, as used in front-door page headers. */
export function Wordmark({ size = 24 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <Logo size={size} />
      <span className="font-mono text-sm tracking-tight">
        blirox<span className="text-accent">/</span>files
      </span>
    </span>
  )
}
