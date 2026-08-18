'use client'

import { useState } from 'react'

export interface AvatarProps {
  userId: string
  username: string
  /** avatar_updated_at — cache-busts when the picture changes. */
  version?: number | null
  hasAvatar?: boolean
  size?: number
  className?: string
}

/**
 * Deterministic tone from the username, so an avatar-less account still has a
 * stable identity rather than a grey blob shared with everyone else.
 *
 * Warm, desaturated, flat — a single colour, not a gradient. The palette stays
 * inside the interface's warm range so initials never introduce a stray hue.
 */
const TONES = ['#8a6b3f', '#7d5a3c', '#6f6248', '#845c46', '#6b6350', '#7a5f52', '#5f5a44']

function toneFor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) % 997
  }
  return TONES[hash % TONES.length]
}

function initials(name: string): string {
  const parts = name.split(/[\s_-]+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

export function Avatar({
  userId,
  username,
  version,
  hasAvatar = true,
  size = 32,
  className = '',
}: AvatarProps) {
  // Falls back to initials both when there is no avatar on record and when the
  // image fails to load (file missing, decode error).
  const [failed, setFailed] = useState(false)
  const showImage = hasAvatar && !failed
  const tone = toneFor(username)

  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-border ${className}`}
      style={{ width: size, height: size }}
      title={username}
    >
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/avatar/${userId}${version ? `?v=${version}` : ''}`}
          alt={username}
          width={size}
          height={size}
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <span
          className="flex h-full w-full items-center justify-center font-medium text-white"
          style={{ background: tone, fontSize: size * 0.4 }}
        >
          {initials(username)}
        </span>
      )}
    </span>
  )
}
