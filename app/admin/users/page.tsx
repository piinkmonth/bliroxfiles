import { redirect } from 'next/navigation'
import { currentUser, hasRole } from '@/lib/auth'
import { db } from '@/lib/db'
import { UsersClient } from './UsersClient'

export const dynamic = 'force-dynamic'

interface UserJoin {
  id: string
  username: string
  email: string | null
  role: 'user' | 'mod' | 'admin'
  status: 'active' | 'suspended' | 'banned'
  quota_bytes: number
  used_bytes: number
  created_at: number
  last_seen_at: number | null
  suspend_reason: string | null
  inviter: string | null
  file_count: number
  invited_count: number
  account_verified_at: number | null
}

export default async function UsersPage() {
  const me = await currentUser()
  if (!me || !hasRole(me, 'admin')) redirect('/admin')

  const users = db()
    .prepare(
      `SELECT u.id, u.username, u.email, u.role, u.status, u.quota_bytes, u.used_bytes,
              u.created_at, u.last_seen_at, u.suspend_reason, u.account_verified_at,
              i.username AS inviter,
              (SELECT COUNT(*) FROM files f
                WHERE f.owner_id = u.id AND f.status = 'active') AS file_count,
              (SELECT COUNT(*) FROM users c WHERE c.invited_by = u.id) AS invited_count
       FROM users u
       LEFT JOIN users i ON i.id = u.invited_by
       ORDER BY u.created_at DESC`,
    )
    .all() as UserJoin[]

  return (
    <UsersClient
      currentUserId={me.id}
      users={users.map((u) => ({
        id: u.id,
        username: u.username,
        email: u.email,
        role: u.role,
        status: u.status,
        quotaBytes: u.quota_bytes,
        usedBytes: u.used_bytes,
        createdAt: u.created_at,
        lastSeenAt: u.last_seen_at,
        suspendReason: u.suspend_reason,
        inviter: u.inviter,
        fileCount: u.file_count,
        invitedCount: u.invited_count,
        verified: !!u.account_verified_at,
      }))}
    />
  )
}
