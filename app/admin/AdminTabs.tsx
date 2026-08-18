'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LayoutDashboard, Ticket, Users, Flag, FileWarning, ScrollText, Files, Image } from 'lucide-react'

export function AdminTabs({
  role,
  openReports,
  pendingIncidents,
}: {
  role: 'user' | 'mod' | 'admin'
  openReports: number
  pendingIncidents: number
}) {
  const pathname = usePathname()
  const isAdmin = role === 'admin'

  const tabs = [
    { href: '/admin', label: 'Overview', icon: LayoutDashboard, show: true },
    { href: '/admin/moderation', label: 'Reports', icon: Flag, badge: openReports, show: true },
    { href: '/admin/files', label: 'Files', icon: Files, show: true },
    {
      href: '/admin/incidents',
      label: 'Incidents',
      icon: FileWarning,
      badge: pendingIncidents,
      urgent: true,
      show: isAdmin,
    },
    { href: '/admin/invites', label: 'Invites', icon: Ticket, show: isAdmin },
    { href: '/admin/users', label: 'Users', icon: Users, show: isAdmin },
    { href: '/admin/appearance', label: 'Appearance', icon: Image, show: isAdmin },
    { href: '/admin/audit', label: 'Audit log', icon: ScrollText, show: isAdmin },
  ].filter((t) => t.show)

  return (
    <nav className="flex gap-1 overflow-x-auto border-b border-border pb-px">
      {tabs.map(({ href, label, icon: Icon, badge, urgent }) => {
        const active = pathname === href
        return (
          <Link
            key={href}
            href={href}
            className={`-mb-px flex items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm transition-colors ${
              active
                ? 'border-accent text-text'
                : 'border-transparent text-muted hover:text-text'
            }`}
          >
            <Icon size={15} />
            {label}
            {badge !== undefined && badge > 0 && (
              <span
                className={`badge ${
                  urgent ? 'bg-danger text-white' : 'bg-raised text-muted'
                }`}
              >
                {badge}
              </span>
            )}
          </Link>
        )
      })}
    </nav>
  )
}
