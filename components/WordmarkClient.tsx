'use client'

import { LogoMark } from './LogoMark'

/**
 * Wordmark for client components.
 *
 * The server-side `Wordmark` resolves the logo path itself via lib/branding.ts,
 * which reads the filesystem — importing that into a 'use client' tree drags
 * node:fs into the browser bundle and the build fails outright. Client callers
 * take the already-resolved path as a prop instead.
 */
export function WordmarkClient({ src, size = 24 }: { src?: string | null; size?: number }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt="blirox"
          width={size}
          height={size}
          className="shrink-0 object-contain"
          style={{ width: size, height: size }}
        />
      ) : (
        <LogoMark size={size} />
      )}
      <span className="font-mono text-sm tracking-tight">
        blirox<span className="text-accent">/</span>files
      </span>
    </span>
  )
}
