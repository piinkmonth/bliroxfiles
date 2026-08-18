import Link from 'next/link'
import type { Metadata } from 'next'
import { Terms } from '@/components/Terms'
import { Wordmark } from '@/components/Logo'
import { ThemePicker } from '@/components/ThemePicker'

export const metadata: Metadata = {
  title: 'terms · blirox/files',
}

export const dynamic = 'force-dynamic'

export default function TermsPage() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <header className="flex items-center">
        <Link href="/" aria-label="blirox files">
          <Wordmark />
        </Link>
        <div className="ml-auto">
          <ThemePicker compact />
        </div>
      </header>

      <main className="py-16">
        <h1 className="font-mono text-xl tracking-tight">Terms of use</h1>
        <p className="mt-2 text-sm text-muted">
          Short version: don&rsquo;t upload anything involving minors, don&rsquo;t use this to
          distribute malware, don&rsquo;t target people, and remember it runs on someone&rsquo;s
          home connection.
        </p>

        <div className="mt-10">
          <Terms />
        </div>
      </main>

      <footer className="border-t border-border pt-6">
        <Link href="/" className="font-mono text-xs text-muted hover:text-text">
          ← back
        </Link>
      </footer>
    </div>
  )
}
