import { redirect } from 'next/navigation'
import { currentUser, hasRole } from '@/lib/auth'
import { db } from '@/lib/db'
import { Nav } from '@/components/Nav'
import { LOGO_SRC } from '@/lib/branding'
import { Background } from '@/components/Background'
import { AdminTabs } from './AdminTabs'

export const dynamic = 'force-dynamic'

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = currentUser()
  if (!user) redirect('/login')
  if (!hasRole(user, 'mod')) redirect('/dashboard')

  const openReports = db()
    .prepare(`SELECT COUNT(*) AS n FROM reports WHERE status = 'open'`)
    .get() as { n: number }

  const pendingIncidents = db()
    .prepare(`SELECT COUNT(*) AS n FROM incidents WHERE ncmec_status = 'pending'`)
    .get() as { n: number }

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
      <main className="mx-auto max-w-6xl px-4 py-8">
        <AdminTabs
          role={user.role}
          openReports={openReports.n}
          pendingIncidents={pendingIncidents.n}
        />
        <div className="mt-6">{children}</div>
      </main>
    </>
  )
}
