import { LogoMark } from '@/components/LogoMark'

/**
 * The "Blirox ID" lockup for the consent screen: brand mark, service name,
 * verified badge.
 *
 * Worth stating plainly, because it is easy to assume otherwise: the badge is
 * drawn by this page, so it proves nothing by itself — any site can render a
 * checkmark. What actually protects the user is the address bar plus the fact
 * that `return_to` is validated server-side against configuration before this
 * page is rendered at all (see lib/suitelink.ts). The badge is a recognition
 * cue, not a security control, and the surrounding copy avoids implying it is.
 *
 * LogoMark is reused so dropping a real public/logo.svg in takes over here too.
 */

export function VerifiedBadge({ size = 15 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className="shrink-0"
      role="img"
      aria-label="Verified service"
    >
      <circle cx="12" cy="12" r="11" fill="currentColor" />
      <path
        d="M7.2 12.4l3.1 3.1 6.4-6.9"
        fill="none"
        stroke="rgb(var(--c-bg))"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function ConsentHeader({ appLabel }: { appLabel: string }) {
  return (
    <div className="flex flex-col items-center gap-5">
      <div className="flex items-center gap-3">
        <span className="text-text">
          <LogoMark size={30} />
        </span>
        <span aria-hidden className="h-6 w-px bg-border" />
        <span className="flex items-center gap-1.5">
          <span className="text-sm font-medium tracking-tight text-text">Blirox ID</span>
          <span className="text-text">
            <VerifiedBadge />
          </span>
        </span>
      </div>

      <p className="text-center font-mono text-[11px] uppercase tracking-[0.18em] text-muted">
        {appLabel}
      </p>
    </div>
  )
}
