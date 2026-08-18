import { redirect } from 'next/navigation'
import { currentUser, hasRole } from '@/lib/auth'
import { listBackgrounds, getBackgroundMode } from '@/lib/backgrounds'
import { AppearanceClient } from './AppearanceClient'

export const dynamic = 'force-dynamic'

export default function AppearancePage() {
  const user = currentUser()
  if (!user || !hasRole(user, 'admin')) redirect('/admin')

  return (
    <AppearanceClient
      backgrounds={listBackgrounds(true)}
      current={getBackgroundMode()}
    />
  )
}
