'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Camera, Loader2, Trash2, Check } from 'lucide-react'
import { Avatar } from '@/components/Avatar'
import { AvatarCropper } from '@/components/AvatarCropper'
import { AccountSection } from './AccountSection'
import { TwoFactorSection } from './TwoFactorSection'
import { SecuritySection } from './SecuritySection'
import { ApiTokensSection } from './ApiTokensSection'
import type { SessionSummary } from '@/lib/auth'
import type { TokenView } from '@/lib/apiviews'

interface Props {
  userId: string
  username: string
  displayName: string | null
  bio: string | null
  hasAvatar: boolean
  avatarVersion: number | null
  googleEnabled: boolean
  googleEmail: string | null
  googleLinkedAt: number | null
  hasPassword: boolean
  twoFactorEnabled: boolean
  twoFactorEnabledAt: number | null
  backupCodesLeft: number
  geoGuard: boolean
  sessions: SessionSummary[]
  apiTokens: TokenView[]
}

export function SettingsClient(props: Props) {
  const router = useRouter()
  const fileRef = useRef<HTMLInputElement>(null)

  const [hasAvatar, setHasAvatar] = useState(props.hasAvatar)
  const [version, setVersion] = useState(props.avatarVersion)
  const [preview, setPreview] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // File chosen but not yet cropped — the cropper owns it until confirmed.
  const [pending, setPending] = useState<File | null>(null)

  const [displayName, setDisplayName] = useState(props.displayName ?? '')
  const [bio, setBio] = useState(props.bio ?? '')
  const [savedProfile, setSavedProfile] = useState(false)

  async function upload(blob: Blob) {
    setBusy(true)
    setError(null)
    setPending(null)

    // Optimistic local preview so the change feels instant on a slow link.
    const localUrl = URL.createObjectURL(blob)
    setPreview(localUrl)

    try {
      const body = new FormData()
      // Already cropped to 256x256 WebP by the cropper; the server re-encodes
      // anyway, which is what strips metadata.
      body.append('avatar', blob, 'avatar.webp')
      const res = await fetch('/api/profile/avatar', { method: 'POST', body })
      const data = await res.json()

      if (!data.ok) {
        setError(data.error)
        setPreview(null)
        return
      }

      setHasAvatar(true)
      setVersion(Date.now())
      router.refresh()
    } catch {
      setError('Upload failed')
      setPreview(null)
    } finally {
      setBusy(false)
      URL.revokeObjectURL(localUrl)
    }
  }

  async function removeAvatar() {
    if (!confirm('Remove your profile picture?')) return
    setBusy(true)
    await fetch('/api/profile/avatar', { method: 'DELETE' })
    setHasAvatar(false)
    setPreview(null)
    setBusy(false)
    router.refresh()
  }

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)

    const res = await fetch('/api/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName, bio }),
    })
    const data = await res.json()

    setBusy(false)
    if (!data.ok) {
      setError(data.error)
      return
    }
    setSavedProfile(true)
    setTimeout(() => setSavedProfile(false), 2000)
    router.refresh()
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Settings</h1>

      {/* Avatar ----------------------------------------------------------- */}
      <section className="card p-6">
        <h2 className="font-medium">Profile picture</h2>
        <p className="mt-1 text-sm text-muted">
          Shown next to your files. Re-encoded on upload, which strips any embedded location data.
        </p>

        <div className="mt-5 flex items-center gap-5">
          <div className="relative">
            {preview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={preview}
                alt=""
                className="h-20 w-20 rounded-full border border-border object-cover"
              />
            ) : (
              <Avatar
                userId={props.userId}
                username={props.username}
                hasAvatar={hasAvatar}
                version={version}
                size={80}
              />
            )}
            {busy && (
              <span className="absolute inset-0 flex items-center justify-center rounded-full bg-bg/80">
                <Loader2 size={20} className="animate-spin text-accent" />
              </span>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => fileRef.current?.click()}
              className="btn-ghost"
              disabled={busy}
            >
              <Camera size={15} />
              {hasAvatar ? 'Change' : 'Upload'}
            </button>

            {hasAvatar && (
              <button onClick={removeAvatar} className="btn-ghost text-danger" disabled={busy}>
                <Trash2 size={15} />
                Remove
              </button>
            )}

            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) setPending(file)
                e.target.value = ''
              }}
            />
          </div>
        </div>

        {pending && (
          <div className="mt-5">
            <AvatarCropper
              file={pending}
              onCancel={() => setPending(null)}
              onCropped={upload}
            />
          </div>
        )}

        <p className="mt-4 text-xs text-muted">JPEG, PNG, WebP, GIF or AVIF. Up to 8 MB.</p>
      </section>

      {/* Profile ---------------------------------------------------------- */}
      <section className="card p-6">
        <h2 className="font-medium">Profile</h2>

        <form onSubmit={saveProfile} className="mt-4 space-y-4">
          <div>
            <label className="label" htmlFor="username">
              Username
            </label>
            <input id="username" className="input opacity-60" value={props.username} disabled />
            <p className="mt-1 text-xs text-muted">
              Usernames can&rsquo;t be changed — they appear in the audit trail.
            </p>
          </div>

          <div>
            <label className="label" htmlFor="displayName">
              Display name <span className="font-normal text-muted">(optional)</span>
            </label>
            <input
              id="displayName"
              className="input"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={40}
              placeholder={props.username}
            />
          </div>

          <div>
            <label className="label" htmlFor="bio">
              Bio <span className="font-normal text-muted">(optional)</span>
            </label>
            <textarea
              id="bio"
              className="input h-24 resize-none"
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              maxLength={280}
            />
            <p className="mt-1 text-right text-xs text-muted">{bio.length}/280</p>
          </div>

          {error && <p className="text-sm text-danger">{error}</p>}

          <button type="submit" className="btn-primary" disabled={busy}>
            {busy && <Loader2 size={15} className="animate-spin" />}
            {savedProfile && <Check size={15} />}
            {savedProfile ? 'Saved' : 'Save changes'}
          </button>
        </form>
      </section>

      <AccountSection
        googleEnabled={props.googleEnabled}
        googleEmail={props.googleEmail}
        googleLinkedAt={props.googleLinkedAt}
        hasPassword={props.hasPassword}
      />

      <TwoFactorSection
        enabled={props.twoFactorEnabled}
        enabledAt={props.twoFactorEnabledAt}
        backupCodesLeft={props.backupCodesLeft}
        hasPassword={props.hasPassword}
      />

      <SecuritySection geoGuard={props.geoGuard} sessions={props.sessions} />

      <ApiTokensSection tokens={props.apiTokens} />
    </div>
  )
}
