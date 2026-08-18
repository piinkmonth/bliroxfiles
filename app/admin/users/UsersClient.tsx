'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Search, Loader2, BadgeCheck } from 'lucide-react'
import { formatBytes, formatRelative } from '@/lib/format'
import { GB_IN_BYTES } from './constants'

interface AdminUser {
  id: string
  username: string
  email: string | null
  role: 'user' | 'mod' | 'admin'
  status: 'active' | 'suspended' | 'banned'
  quotaBytes: number
  usedBytes: number
  createdAt: number
  lastSeenAt: number | null
  suspendReason: string | null
  inviter: string | null
  fileCount: number
  invitedCount: number
  verified: boolean
}

export function UsersClient({
  users,
  currentUserId,
}: {
  users: AdminUser[]
  currentUserId: string
}) {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  const filtered = query.trim()
    ? users.filter((u) => u.username.toLowerCase().includes(query.trim().toLowerCase()))
    : users

  async function patch(user: AdminUser, body: Record<string, unknown>) {
    setBusy(user.id)
    const res = await fetch(`/api/admin/users/${user.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    setBusy(null)
    if (!data.ok) alert(data.error)
    router.refresh()
  }

  async function setStatus(user: AdminUser, status: AdminUser['status']) {
    if (status !== 'active') {
      const verb = status === 'banned' ? 'Ban' : 'Suspend'
      const extra =
        user.invitedCount > 0
          ? `\n\nThey invited ${user.invitedCount} other account${
              user.invitedCount === 1 ? '' : 's'
            } — those stay active unless you handle them separately.`
          : ''
      if (!confirm(`${verb} ${user.username}? Their sessions end immediately.${extra}`)) return
      const reason = prompt('Reason (shown to them at sign-in):') ?? undefined
      await patch(user, { status, reason })
    } else {
      await patch(user, { status })
    }
  }

  async function toggleVerified(user: AdminUser) {
    let note: string | undefined
    if (!user.verified) {
      const answer = prompt(
        `Give ${user.username} a verified check?\n\n` +
          `It appears next to their name on every file they share. Optional note:`,
      )
      if (answer === null) return
      note = answer || undefined
    } else if (!confirm(`Remove the verified check from ${user.username}?`)) {
      return
    }
    await patch(user, { verified: !user.verified, verifiedNote: note })
  }

  async function setQuota(user: AdminUser) {
    const current = Math.round(user.quotaBytes / GB_IN_BYTES)
    const input = prompt(`Storage allocation for ${user.username}, in GB:`, String(current))
    if (input === null) return
    const gb = Number(input)
    if (!Number.isFinite(gb) || gb < 0) return alert('That is not a valid number.')
    if (gb * GB_IN_BYTES < user.usedBytes) {
      if (
        !confirm(
          `${user.username} is already using ${formatBytes(user.usedBytes)}. ` +
            `Setting the quota lower blocks new uploads but does not delete anything. Continue?`,
        )
      )
        return
    }
    await patch(user, { quotaGb: gb })
  }

  return (
    <div className="space-y-4">
      <div className="relative max-w-sm">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
        <input
          className="input pl-9"
          placeholder="Search users"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="card divide-y divide-border">
        {filtered.map((user) => {
          const pct = user.quotaBytes > 0 ? (user.usedBytes / user.quotaBytes) * 100 : 0
          const isSelf = user.id === currentUserId

          return (
            <div key={user.id} className={`p-4 ${busy === user.id ? 'opacity-50' : ''}`}>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{user.username}</span>
                    {user.role !== 'user' && (
                      <span className="badge bg-accent/15 text-accent">{user.role}</span>
                    )}
                    {user.status !== 'active' && (
                      <span className="badge bg-danger/15 text-danger">{user.status}</span>
                    )}
                    {user.verified && (
                      <BadgeCheck size={14} className="text-accent" aria-label="verified account" />
                    )}
                    {isSelf && <span className="badge bg-raised text-muted">you</span>}
                  </div>

                  <p className="mt-1 text-xs text-muted">
                    {user.fileCount} file{user.fileCount === 1 ? '' : 's'} ·{' '}
                    {formatBytes(user.usedBytes)} of {formatBytes(user.quotaBytes)}
                    {user.inviter && <> · invited by {user.inviter}</>}
                    {user.invitedCount > 0 && <> · invited {user.invitedCount}</>}
                    {' · joined '}
                    {formatRelative(user.createdAt)}
                    {user.lastSeenAt && <> · seen {formatRelative(user.lastSeenAt)}</>}
                  </p>

                  {user.suspendReason && (
                    <p className="mt-1 text-xs text-danger">{user.suspendReason}</p>
                  )}

                  <div className="mt-2 h-1 w-full max-w-xs overflow-hidden bg-raised">
                    <div
                      className={`h-full ${
                        pct > 90 ? 'bg-danger' : pct > 75 ? 'bg-warn' : 'bg-accent'
                      }`}
                      style={{ width: `${Math.min(100, pct)}%` }}
                    />
                  </div>
                </div>

                <div className="flex shrink-0 flex-wrap gap-2">
                  {busy === user.id && <Loader2 size={15} className="animate-spin text-muted" />}

                  <button onClick={() => setQuota(user)} className="btn-ghost text-xs">
                    Quota
                  </button>

                  <button
                    onClick={() => toggleVerified(user)}
                    className={`btn-ghost text-xs ${user.verified ? 'text-accent' : ''}`}
                    title={
                      user.verified
                        ? 'Remove the verified check'
                        : 'Mark this account verified — shows a check wherever their name appears'
                    }
                  >
                    <BadgeCheck size={13} />
                    {user.verified ? 'Verified' : 'Verify'}
                  </button>

                  {!isSelf && (
                    <>
                      {user.status === 'active' ? (
                        <>
                          <button
                            onClick={() => setStatus(user, 'suspended')}
                            className="btn-ghost text-xs"
                          >
                            Suspend
                          </button>
                          <button
                            onClick={() => setStatus(user, 'banned')}
                            className="btn-ghost text-xs text-danger"
                          >
                            Ban
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={() => setStatus(user, 'active')}
                          className="btn-ghost text-xs text-success"
                        >
                          Reinstate
                        </button>
                      )}

                      <select
                        className="input w-auto py-1 text-xs"
                        value={user.role}
                        onChange={(e) => patch(user, { role: e.target.value })}
                        aria-label={`Role for ${user.username}`}
                      >
                        <option value="user">user</option>
                        <option value="mod">mod</option>
                        <option value="admin">admin</option>
                      </select>
                    </>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
