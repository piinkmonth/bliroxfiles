import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth'
import { SplitLayout } from '@/components/SplitLayout'
import { LoginForm } from './LoginForm'
import { LOGO_SRC } from '@/lib/branding'
import { googleConfigured } from '@/lib/oauth'

export const dynamic = 'force-dynamic'

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await currentUser()) redirect('/dashboard')
  const { error } = await searchParams
  return (
    // Mirrored against the landing page so moving between them feels like one
    // site rather than two separate templates.
    <SplitLayout reverse>
      <LoginForm
        logoSrc={LOGO_SRC}
        googleEnabled={googleConfigured()}
        initialError={error ?? null}
      />
    </SplitLayout>
  )
}
