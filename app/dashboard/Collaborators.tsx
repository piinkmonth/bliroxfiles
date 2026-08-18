'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Users, UserPlus, X, Loader2, Eye, Upload } from 'lucide-react'
import { Avatar } from '@/components/Avatar'
import { formatRelative } from '@/lib/format'
import type { Collaborator } from '@/lib/collab'

/**
 * Who else can reach an encrypted folder.
 *
 * The distinction this panel has to make honestly, because it is the one people
 * get wrong: adding someone here lets them *fetch* the folder's contents. It
 * does not give them the passphrase, and the server cannot — it has never had
 * it. The passphrase goes to them some other way, chosen by the owner.
 */
export function Collaborators({
  folderId,
  collaborators,
}: {
  folderId: string
  collaborators: Collaborator[]
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [username, setUsername] = useState('')
  const [role, setRole] = useState<'viewer' | 'contributor'>('viewer')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function add(e: React.FormEvent) {
    e.preventDefault()
    setBusy('add')
    setError(null)

    const res = await fetch(`/api/folders/${folderId}/collaborators`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, role }),
    })
    const data = await res.json()

    setBusy(null)
    if (!data.ok) {
      setError(data.error)
      return
    }
    setUsername('')
    router.refresh()
  }

  async function remove(c: Collaborator) {
    if (!confirm(`Remove ${c.username} from this folder? They lose access immediately.`)) {
      return
    }

    setBusy(c.userId)
    const res = await fetch(
      `/api/folders/${folderId}/collaborators?userId=${encodeURIComponent(c.userId)}`,
      { method: 'DELETE' },
    )
    const data = await res.json()

    setBusy(null)
    if (!data.ok) setError(data.error)
    router.refresh()
  }

  return (
    <section className="card p-4">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left"
      >
        <Users size={15} className="text-muted" />
        <span className="text-sm font-medium">Collaborators</span>
        <span className="font-mono text-[11px] text-muted">
          {collaborators.length === 0
            ? 'nobody yet'
            : `${collaborators.length} ${collaborators.length === 1 ? 'person' : 'people'}`}
        </span>
        <span className="ml-auto font-mono text-[11px] text-muted">{open ? 'hide' : 'manage'}</span>
      </button>

      {open && (
        <div className="mt-4 border-t border-border pt-4">
          <p className="text-xs leading-relaxed text-muted">
            Added people can see and download this folder. Send them the passphrase yourself — it
            was never uploaded here.
          </p>

          {collaborators.length > 0 && (
            <ul className="mt-4 divide-y divide-border">
              {collaborators.map((c) => (
                <li key={c.userId} className="flex items-center gap-3 py-2.5">
                  <Avatar
                    userId={c.userId}
                    username={c.username}
                    hasAvatar={c.hasAvatar}
                    version={c.avatarVersion}
                    size={26}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{c.displayName || c.username}</p>
                    <p className="font-mono text-[11px] text-muted">
                      {c.role === 'contributor' ? 'can add files' : 'can view'} · added{' '}
                      {formatRelative(c.createdAt)}
                    </p>
                  </div>
                  <button
                    onClick={() => remove(c)}
                    disabled={busy === c.userId}
                    className="shrink-0 rounded p-1.5 text-muted hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                    title={`Remove ${c.username}`}
                  >
                    {busy === c.userId ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <X size={14} />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <form onSubmit={add} className="mt-4 flex flex-wrap gap-2">
            <input
              className="input min-w-0 flex-1"
              placeholder="Username to invite"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              maxLength={40}
              required
            />
            <select
              className="input w-auto shrink-0"
              value={role}
              onChange={(e) => setRole(e.target.value as 'viewer' | 'contributor')}
            >
              <option value="viewer">Can view</option>
              <option value="contributor">Can add files</option>
            </select>
            <button type="submit" className="btn-primary shrink-0" disabled={busy === 'add'}>
              {busy === 'add' ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <UserPlus size={14} />
              )}
              Invite
            </button>
          </form>

          <p className="mt-2 flex items-center gap-3 font-mono text-[10px] text-muted">
            <span className="inline-flex items-center gap-1">
              <Eye size={10} /> view = download and decrypt
            </span>
            <span className="inline-flex items-center gap-1">
              <Upload size={10} /> add = also upload into it
            </span>
          </p>

          {error && (
            <p className="mt-3 border-l-2 border-danger pl-3 text-sm text-danger">{error}</p>
          )}
        </div>
      )}
    </section>
  )
}
