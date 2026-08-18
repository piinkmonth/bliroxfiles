'use client'

import Link from 'next/link'
import { Lock, Users } from 'lucide-react'
import { FolderName } from './FolderName'
import { formatBytes } from '@/lib/format'

export interface SharedEntry {
  id: string
  name: string
  encrypted: number
  role: 'viewer' | 'contributor'
  ownerName: string
  file_count: number
  total_bytes: number
}

// encrypted folders other people shared with u. own section, not mixed in with
// your own folders, so its obvious whose files these are + whose quota they hit
export function SharedWithMe({ folders }: { folders: SharedEntry[] }) {
  if (folders.length === 0) return null

  return (
    <section>
      <h2 className="mb-3 flex items-center gap-2 font-mono text-xs uppercase tracking-wide text-muted">
        <Users size={13} />
        shared with you
      </h2>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {folders.map((f) => (
          <Link
            key={f.id}
            href={`/dashboard?folder=${f.id}`}
            className="card flex items-center gap-3 p-3 transition-colors hover:border-accent/40"
          >
            <Lock size={16} className="shrink-0 text-accent" />
            <span className="min-w-0">
              <span className="block truncate text-sm">
                <FolderName id={f.id} name={f.name} encrypted={f.encrypted} />
              </span>
              <span className="block font-mono text-[11px] text-muted">
                {f.ownerName} · {f.file_count} file{f.file_count === 1 ? '' : 's'}
                {f.total_bytes > 0 && ` · ${formatBytes(f.total_bytes)}`}
                {f.role === 'contributor' && ' · can add'}
              </span>
            </span>
          </Link>
        ))}
      </div>
    </section>
  )
}
