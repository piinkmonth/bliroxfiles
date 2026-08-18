/**
 * Placeholder mark: a lowercase serif 'b', matching the real logo's character.
 *
 * Set as SVG <text> in a serif stack rather than hand-authored bezier paths —
 * an approximated Didone bowl drawn by hand looks subtly wrong in a way that
 * is worse than an honest letterform. Georgia and Times are present on
 * effectively every system, so this renders consistently in practice.
 *
 * This is only ever shown when public/logo.* is absent. Drop the real file in
 * and it takes over everywhere; see lib/branding.ts.
 *
 * Zero imports, so it is safe in both server and client components.
 */
export function LogoMark({ size = 26, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={`shrink-0 ${className}`}
      role="img"
      aria-label="blirox"
    >
      <text
        x="50"
        y="50"
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily="Georgia, 'Times New Roman', 'Liberation Serif', serif"
        fontSize="96"
        fill="currentColor"
      >
        b
      </text>
    </svg>
  )
}
