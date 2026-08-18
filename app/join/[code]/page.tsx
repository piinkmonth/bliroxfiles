import { redirect } from 'next/navigation'
import Link from 'next/link'
import { currentUser } from '@/lib/auth'
import { checkInvite } from '@/lib/invites'
import { formatBytes } from '@/lib/format'
import { SplitLayout } from '@/components/SplitLayout'
import { JoinForm } from './JoinForm'
import { LOGO_SRC } from '@/lib/branding'
import { googleConfigured } from '@/lib/oauth'

export const dynamic = 'force-dynamic'

export default async function JoinPage({ params }: { params: Promise<{ code: string }> }) {
  if (await currentUser()) redirect('/dashboard')

  const { code } = await params
  const check = checkInvite(code)

  if (!check.valid) {
    return (
      <SplitLayout>
        <div className="flex flex-1 flex-col justify-center px-10 py-10 xl:px-16">
          <h1 className="font-mono text-xl tracking-tight">Invite not valid</h1>
          <p className="mt-3 max-w-sm text-sm text-muted">{check.reason}</p>
          <Link href="/login" className="btn-ghost mt-8 self-start">
            Go to sign in
          </Link>
        </div>
      </SplitLayout>
    )
  }

  return (
    <SplitLayout>
      <JoinForm
        code={code}
        quotaLabel={formatBytes(check.invite.quota_bytes)}
        logoSrc={LOGO_SRC}
        googleEnabled={googleConfigured()}
      />
    </SplitLayout>
  )
}
