import { redirect } from 'next/navigation'
import { currentUser, sessionsForUser } from '@/lib/auth'
import { Nav } from '@/components/Nav'
import { LOGO_SRC } from '@/lib/branding'
import { googleConfigured } from '@/lib/oauth'
import { Background } from '@/components/Background'
import { listTokens } from '@/lib/apitokens'
import { tokenView } from '@/lib/apiviews'
import { SettingsClient } from './SettingsClient'

export const dynamic = 'force-dynamic'

export default async function SettingsPage() {
  const user = await currentUser()
  if (!user) redirect('/login')

  const sessions = await sessionsForUser(user.id)

  return (
    <>
      <Background />
      <Nav
        logoSrc={LOGO_SRC}
        user={{
          id: user.id,
          username: user.username,
          role: user.role,
          usedBytes: user.used_bytes,
          quotaBytes: user.quota_bytes,
          hasAvatar: !!user.avatar_path,
          avatarVersion: user.avatar_updated_at,
        }}
      />
      <main className="mx-auto max-w-2xl px-4 py-8">
        <SettingsClient
          userId={user.id}
          username={user.username}
          displayName={user.display_name}
          bio={user.bio}
          hasAvatar={!!user.avatar_path}
          avatarVersion={user.avatar_updated_at}
          googleEnabled={googleConfigured()}
          googleEmail={user.google_email}
          googleLinkedAt={user.google_linked_at}
          hasPassword={!!user.password_hash}
          twoFactorEnabled={!!user.totp_enabled}
          twoFactorEnabledAt={user.totp_enabled_at}
          backupCodesLeft={
            user.totp_backup_codes ? (JSON.parse(user.totp_backup_codes) as string[]).length : 0
          }
          geoGuard={!!user.geo_guard}
          sessions={sessions}
          apiTokens={listTokens(user.id).map(tokenView)}
        />
      </main>
    </>
  )
}
