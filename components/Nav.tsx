'use client'

import Link from 'next/link'
import { useRouter, usePathname } from 'next/navigation'
import { LogOut, Shield, Files, Settings } from 'lucide-react'
import { ThemePicker } from './ThemePicker'
import { Avatar } from './Avatar'
import { LogoMark } from './LogoMark'
import { formatBytes } from '@/lib/format'

export interface NavUser {
  id: string
  username: string
  role: 'user' | 'mod' | 'admin'
  usedBytes: number
  quotaBytes: number
  hasAvatar?: boolean
  avatarVersion?: number | null
}

/**
 * Resolved by the server page and passed down, because this is a client
 * component and the lookup in lib/branding.ts uses fs.
 */
export function Nav({ user, logoSrc }: { user: NavUser; logoSrc?: string | null }) {
  const router = useRouter()
  const pathname = usePathname()
  const pct = user.quotaBytes > 0 ? (user.usedBytes / user.quotaBytes) * 100 : 0

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' })
    router.push('/login')
    router.refresh()
  }

  const links = [
    { href: '/dashboard', label: 'files', icon: Files },
    ...(user.role !== 'user' ? [{ href: '/admin', label: 'admin', icon: Shield }] : []),
  ]

  return (
    <header className="sticky top-0 z-40 border-b border-border/50 bg-bg/70 backdrop-blur-xl">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
        <Link href="/dashboard" className="flex items-center gap-2.5" aria-label="blirox files">
          {logoSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logoSrc}
              alt="blirox"
              width={22}
              height={22}
              className="shrink-0 object-contain"
              style={{ width: 22, height: 22 }}
            />
          ) : (
            <LogoMark size={22} />
          )}
          <span className="hidden font-mono text-sm tracking-tight sm:inline">
            blirox<span className="text-accent">/</span>files
          </span>
        </Link>

        <nav className="flex items-center gap-1">
          {links.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || pathname.startsWith(`${href}/`)
            return (
              <Link
                key={href}
                href={href}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-colors ${
                  active ? 'bg-raised/70 text-text' : 'text-muted hover:text-text'
                }`}
              >
                <Icon size={15} />
                <span className="hidden sm:inline">{label}</span>
              </Link>
            )
          })}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          <div
            className="hidden sm:block"
            title={`${formatBytes(user.usedBytes)} of ${formatBytes(user.quotaBytes)}`}
          >
            <div className="mb-1 text-right text-xs text-muted">
              {formatBytes(user.usedBytes)} / {formatBytes(user.quotaBytes)}
            </div>
            <div className="h-1 w-32 overflow-hidden bg-raised">
              <div
                className={`h-full transition-[width] ${
                  pct > 90 ? 'bg-danger' : pct > 75 ? 'bg-warn' : 'bg-accent'
                }`}
                style={{ width: `${Math.min(100, pct)}%` }}
              />
            </div>
          </div>

          <ThemePicker compact />

          <Link
            href="/settings"
            className="rounded-lg p-2 text-muted transition-colors hover:bg-raised/60 hover:text-text"
            aria-label="Settings"
            title="Settings"
          >
            <Settings size={16} />
          </Link>

          <Link href="/settings" aria-label="Your profile">
            <Avatar
              userId={user.id}
              username={user.username}
              hasAvatar={user.hasAvatar}
              version={user.avatarVersion}
              size={30}
              className="transition-opacity hover:opacity-80"
            />
          </Link>

          <button
            onClick={logout}
            className="rounded-lg p-2 text-muted transition-colors hover:bg-raised/60 hover:text-danger"
            aria-label="Sign out"
            title="Sign out"
          >
            <LogOut size={15} />
          </button>
        </div>
      </div>
    </header>
  )
}
