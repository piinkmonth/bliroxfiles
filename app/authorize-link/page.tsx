import type { Metadata } from 'next'
import LinkForm from './LinkForm'
import { ConsentHeader } from './ConsentMark'
import { isReturnAllowed, linkingAvailable } from '@/lib/suitelink'

export const metadata: Metadata = {
  title: 'Link to Blirox ID',
  robots: { index: false, follow: false },
}
export const dynamic = 'force-dynamic'

/**
 * consent screen for blirox service linking, upcoming service id.example.com
 */
export default function AuthorizeLinkPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>
}) {
  const str = (k: string) => {
    const v = searchParams[k]
    return typeof v === 'string' ? v : undefined
  }

  const state = str('state')
  const returnTo = str('return_to')

  if (!linkingAvailable()) {
    return (
      <Refusal title="Linking is unavailable">
        This server has not been configured for account linking yet. It needs{' '}
        <code className="font-mono text-xs text-text">BLIROX_LINK_SECRET</code> and{' '}
        <code className="font-mono text-xs text-text">BLIROX_ID_ORIGIN</code> set.
      </Refusal>
    )
  }

  if (!state || !returnTo) {
    return (
      <Refusal title="Incomplete request">
        This page is reached from your Blirox account settings. Start the
        connection there rather than opening this link directly.
      </Refusal>
    )
  }

  if (!isReturnAllowed(returnTo)) {
    return (
      <Refusal title="Unrecognised destination">
        This request asks to send your account details somewhere that is not the
        Blirox account service. Nothing has been sent. If you followed this from
        an email or a message, treat it as suspicious.
      </Refusal>
    )
  }

  const idHost = new URL(returnTo).host

  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm">
        <ConsentHeader appLabel="Blirox Files" />

        <div className="mt-10 rounded-card border border-border bg-surface p-6">
          <h1 className="text-center text-lg font-semibold tracking-tight">
            Link your account to Blirox ID?
          </h1>
          <p className="mt-3 text-center text-sm leading-relaxed text-muted">
            Your Blirox Files account will be connected to your Blirox account.
            Your uploads, folders and storage allowance stay exactly where they
            are — nothing here changes.
          </p>

          <div className="my-6 h-px bg-border" />

          <LinkForm state={state} returnTo={returnTo} />
        </div>

        <p className="mt-6 text-center text-xs leading-relaxed text-muted">
          You are signing in again even if you are already signed in here. Being
          signed in is not proof that <em>you</em> asked for this — without a
          fresh check, someone could send you this link and have your account
          connected to theirs.
        </p>

        <p className="mt-4 text-center font-mono text-[11px] text-muted/70">
          returning to {idHost}
        </p>
      </div>
    </main>
  )
}

function Refusal({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm">
        <ConsentHeader appLabel="Blirox Files" />
        <div className="mt-10 rounded-card border border-border bg-surface p-6">
          <h1 className="text-center text-base font-semibold tracking-tight text-danger">
            {title}
          </h1>
          <p className="mt-3 text-center text-sm leading-relaxed text-muted">{children}</p>
        </div>
      </div>
    </main>
  )
}
