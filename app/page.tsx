import Link from 'next/link'
import { Wordmark } from '@/components/Logo'
import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth'
import { SplitLayout } from '@/components/SplitLayout'
import { ThemePicker } from '@/components/ThemePicker'
import { LIMITS } from '@/lib/config'
import { formatBytes } from '@/lib/format'

export const dynamic = 'force-dynamic'

export default function Landing() {
  // Signed-in visitors have no use for the pitch.
  if (currentUser()) redirect('/dashboard')

  const specs: [string, string][] = [
    ['max file', formatBytes(LIMITS.maxFileBytes)],
    ['per account', formatBytes(LIMITS.defaultQuotaBytes)],
    ['signup', 'invite only'],
    ['resumable', 'yes'],
    ['api', 'yes'],
    ['ads / timers', 'none'],
  ]

  return (
    <SplitLayout>
      <div className="flex flex-1 flex-col px-10 py-10 xl:px-16">
        <header className="flex items-center">
          <Wordmark />
          <nav className="ml-auto flex items-center gap-5">
            <Link
              href="/developers"
              className="font-mono text-xs text-muted transition-colors hover:text-accent"
            >
              developers
            </Link>
            <ThemePicker compact />
          </nav>
        </header>

        <main className="flex flex-1 flex-col justify-center py-16">
          {/*
           * Headline is mono and modestly sized rather than a 60px bold sans
           * slab. The photograph is carrying this page; the type does not need
           * to shout over it, and shouting is what makes a hero look stock.
           */}
          <h1 className="max-w-md font-mono text-2xl leading-snug tracking-tight">
            Somewhere to put
            <br />
            the big files.
          </h1>

          <p className="mt-6 max-w-sm text-sm leading-relaxed text-muted">
            No countdown timers, no fake download buttons, no four ads stacked on top of the thing
            you actually came for. Upload it, get a link, send the link.
          </p>

          <dl className="mt-10 max-w-sm font-mono text-xs">
            {specs.map(([term, value]) => (
              <div key={term} className="flex items-baseline gap-3 py-2">
                <dt className="text-muted">{term}</dt>
                {/* Leader dots — a printed-table device, not a UI-kit one. */}
                <span className="flex-1 translate-y-[-3px] border-b border-dotted border-border" />
                <dd>{value}</dd>
              </div>
            ))}
          </dl>

          <div className="mt-10 flex items-center gap-5">
            <Link href="/login" className="btn-primary">
              Sign in
            </Link>
            <span className="text-xs text-muted">
              Got an invite link? Just open it.
            </span>
          </div>
        </main>

        <footer className="max-w-sm border-t border-border pt-6 font-mono text-[11px] leading-relaxed text-muted">
          <p>
            <span className="text-danger">csam → permanent removal + NCMEC report</span>, with the
            IP, the upload history, and whoever issued the invite. no warning, no appeal.
          </p>
        </footer>
      </div>
    </SplitLayout>
  )
}
