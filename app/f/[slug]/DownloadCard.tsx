'use client'

import { useState } from 'react'
import { WordmarkClient } from '@/components/WordmarkClient'
import Link from 'next/link'
import { Download, Flag, Check, X, Loader2, BadgeCheck, KeyRound, UserRound, Link2, Flame, Clock, QrCode } from 'lucide-react'
import { ThemePicker } from '@/components/ThemePicker'
import { Avatar } from '@/components/Avatar'
import { formatBytes } from '@/lib/format'
import { FilePreview } from './FilePreview'
import { CopyLink } from './CopyLink'
import type { PreviewKind } from '@/lib/preview'

interface Uploader {
  id: string
  username: string
  displayName: string | null
  hasAvatar: boolean
  avatarVersion: number | null
  verified: boolean
  verifiedNote: string | null
}

interface Props {
  slug: string
  name: string
  sizeBytes: number
  mime: string | null
  downloads: number
  createdAt: number
  /** null when the upload was shared anonymously. */
  uploader: Uploader | null
  sha256: string
  downloadUrl: string
  logoSrc?: string | null
  country: string | null
  verified: { at: number; by: string; note: string | null } | null
  previewKind: PreviewKind
  /** Path to the generated still, when this file has one. */
  thumbUrl: string | null
  note: string | null
  expiresAt: number | null
  /** Downloads left before the file destroys itself. */
  burnAfter: number | null
  passwordProtected: boolean
}

/** "in 6 days", "in 2 hours", "in 4 minutes". */
function untilLabel(ms: number): string {
  const diff = ms - Date.now()
  if (diff <= 0) return 'now'
  const units: [number, Intl.RelativeTimeFormatUnit][] = [
    [86400_000, 'day'],
    [3600_000, 'hour'],
    [60_000, 'minute'],
  ]
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  for (const [size, unit] of units) {
    if (diff >= size) return rtf.format(Math.round(diff / size), unit)
  }
  return 'in under a minute'
}

/** en-GB gives "30 July 2026" rather than the ambiguous 07/30/2026. */
function localTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(undefined, { type: 'region' }).of(code) ?? code
  } catch {
    return code
  }
}

export function DownloadCard(props: Props) {
  const [reporting, setReporting] = useState(false)
  const [showQr, setShowQr] = useState(false)
  const [locked, setLocked] = useState(props.passwordProtected)
  const [password, setPassword] = useState('')
  const [unlocking, setUnlocking] = useState(false)
  const [unlockError, setUnlockError] = useState<string | null>(null)

  async function unlock(e: React.FormEvent) {
    e.preventDefault()
    setUnlocking(true)
    setUnlockError(null)

    const res = await fetch(`/api/files/unlock/${props.slug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    const data = await res.json()
    setUnlocking(false)

    if (!data.ok) {
      setUnlockError(data.error)
      return
    }
    setLocked(false)
  }

  return (
    <div className="flex flex-1 flex-col px-10 py-10 xl:px-16">
      <header className="flex items-center">
        <Link href="/" aria-label="blirox files">
          <WordmarkClient src={props.logoSrc} />
        </Link>
        <div className="ml-auto">
          <ThemePicker compact />
        </div>
      </header>

      <main className="flex flex-1 flex-col justify-center py-16">
        <p className="font-mono text-xs text-muted">shared file</p>

        <h1 className="mt-3 flex max-w-lg items-start gap-2 break-words text-2xl font-medium leading-snug">
          <span>{props.name}</span>
          {props.verified && (
            <span
              title={`Verified by ${props.verified.by}${props.verified.note ? ` — ${props.verified.note}` : ''}`}
              className="mt-1.5 inline-flex shrink-0 items-center gap-1 rounded bg-accent/15 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-accent"
            >
              <BadgeCheck size={11} />
              verified
            </span>
          )}
        </h1>

        {/* A password-protected file shows nothing until it is unlocked —
            a preview is the content, so it sits behind the same gate. */}
        {!locked && (
          <FilePreview
            kind={props.previewKind}
            name={props.name}
            sizeBytes={props.sizeBytes}
            inlineUrl={`${props.downloadUrl}?inline=1`}
            thumbUrl={props.thumbUrl}
          />
        )}

        {props.note && (
          <p className="mt-4 max-w-sm whitespace-pre-wrap border-l-2 border-border pl-3 text-sm leading-relaxed text-muted">
            {props.note}
          </p>
        )}

        {/* Anything that makes this link temporary is stated up front rather
            than in the detail list — it changes whether you download now. */}
        {(props.burnAfter !== null || props.expiresAt) && (
          <div className="mt-5 max-w-sm space-y-1.5 border-l-2 border-warn pl-3">
            {props.burnAfter !== null && (
              <p className="flex items-center gap-1.5 text-xs text-warn">
                <Flame size={12} />
                {props.burnAfter === 1
                  ? 'Deleted after one more download'
                  : `Deleted after ${props.burnAfter} more downloads`}
              </p>
            )}
            {props.expiresAt && (
              <p className="flex items-center gap-1.5 text-xs text-warn">
                <Clock size={12} />
                Link expires {untilLabel(props.expiresAt)}
              </p>
            )}
          </div>
        )}

        <dl className="mt-6 max-w-sm font-mono text-xs">
          {(
            [
              ['size', formatBytes(props.sizeBytes)],
              ['type', props.mime || 'unknown'],
              ['uploaded', localTime(props.createdAt)],
              ...(props.country
                ? ([['origin', countryName(props.country)]] as [string, string][])
                : []),
              ['downloads', String(props.downloads)],
            ] as [string, string][]
          ).map(([term, value]) => (
            <div key={term} className="flex items-baseline gap-3 py-1.5">
              <dt className="text-muted">{term}</dt>
              <span className="flex-1 translate-y-[-3px] border-b border-dotted border-border" />
              <dd className="truncate">{value}</dd>
            </div>
          ))}
        </dl>

        {locked ? (
          <form onSubmit={unlock} className="mt-8 max-w-sm space-y-3">
            <div>
              <label className="label" htmlFor="share-pw">
                <span className="inline-flex items-center gap-1.5">
                  <KeyRound size={12} />
                  This file is password protected
                </span>
              </label>
              <input
                id="share-pw"
                type="password"
                className="input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="off"
                autoFocus
                required
              />
            </div>
            {unlockError && (
              <p className="border-l-2 border-danger pl-3 text-sm text-danger">{unlockError}</p>
            )}
            <button type="submit" className="btn-primary w-full py-2.5" disabled={unlocking}>
              {unlocking && <Loader2 size={15} className="animate-spin" />}
              Unlock
            </button>
          </form>
        ) : (
          <div className="mt-8 max-w-sm">
            <a href={props.downloadUrl} className="btn-primary w-full py-2.5">
              <Download size={16} />
              Download
            </a>

            {/*
              The direct link, for anything that wants the bytes rather than
              this page — a script, an <img> tag, a curl. It is the same URL
              the button above uses, spelled out so it can be copied without
              having to right-click and hope.
            */}
            <details className="mt-3 text-xs">
              <summary className="inline-flex cursor-pointer select-none items-center gap-1.5 font-mono text-[11px] text-muted hover:text-text">
                <Link2 size={12} />
                direct link
              </summary>
              <div className="mt-2">
                <CopyLink url={props.downloadUrl} />
                <p className="mt-2 font-mono text-[10px] leading-relaxed text-muted">
                  serves the file itself, with no page around it. supports range requests, so it
                  can be resumed and seeked.
                </p>
              </div>
            </details>

            <button
              onClick={() => setShowQr((v) => !v)}
              className="mt-2 inline-flex items-center gap-1.5 font-mono text-[11px] text-muted hover:text-text"
              aria-expanded={showQr}
            >
              <QrCode size={12} />
              {showQr ? 'hide qr code' : 'qr code'}
            </button>

            {showQr && (
              <div className="mt-2 w-fit border border-border bg-white p-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/qr/${props.slug}`}
                  alt={`QR code linking to ${props.name}`}
                  className="h-40 w-40"
                />
              </div>
            )}
          </div>
        )}

        <div className="mt-8 flex max-w-sm items-center gap-2.5 border-t border-border pt-5">
          {props.uploader ? (
            <>
              <Avatar
                userId={props.uploader.id}
                username={props.uploader.username}
                hasAvatar={props.uploader.hasAvatar}
                version={props.uploader.avatarVersion}
                size={26}
              />
              <span className="flex items-center gap-1.5 text-xs text-muted">
                uploaded by{' '}
                <span className="inline-flex items-center gap-1 text-text">
                  {props.uploader.displayName || props.uploader.username}
                  {props.uploader.verified && (
                    <BadgeCheck
                      size={13}
                      className="text-accent"
                      aria-label="verified account"
                    />
                  )}
                </span>
              </span>
            </>
          ) : (
            <span className="flex items-center gap-2 text-xs text-muted">
              <UserRound size={16} />
              shared anonymously
            </span>
          )}
        </div>

        <details className="mt-6 max-w-sm font-mono text-[11px] text-muted">
          <summary className="cursor-pointer select-none hover:text-text">checksum</summary>
          <p className="mt-2 break-all">{props.sha256}</p>
        </details>
      </main>

      <footer className="max-w-sm border-t border-border pt-5">
        {reporting ? (
          <ReportForm slug={props.slug} onClose={() => setReporting(false)} />
        ) : (
          <button
            onClick={() => setReporting(true)}
            className="inline-flex items-center gap-1.5 font-mono text-[11px] text-muted hover:text-danger"
          >
            <Flag size={12} />
            report this file
          </button>
        )}
      </footer>
    </div>
  )
}

const CATEGORIES = [
  { id: 'csam', label: 'Sexual content involving a minor', urgent: true },
  { id: 'malware', label: 'Malware or a scam' },
  { id: 'copyright', label: 'Copyright infringement' },
  { id: 'other', label: 'Something else' },
]

function ReportForm({ slug, onClose }: { slug: string; onClose: () => void }) {
  const [category, setCategory] = useState('')
  const [detail, setDetail] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setState('sending')
    try {
      const res = await fetch('/api/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, category, detail }),
      })
      const data = await res.json()
      setState(data.ok ? 'sent' : 'error')
    } catch {
      setState('error')
    }
  }

  if (state === 'sent') {
    return (
      <div className="border-l-2 border-success pl-4 text-sm">
        <p className="flex items-center gap-1.5 font-medium text-success">
          <Check size={14} />
          Report received
        </p>
        <p className="mt-1.5 text-xs text-muted">
          {category === 'csam'
            ? 'Escalated for immediate review. Thank you — reports like this get acted on.'
            : 'A moderator will look at this.'}
        </p>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="text-left">
      <div className="flex items-center justify-between">
        <h2 className="font-mono text-xs">report this file</h2>
        <button type="button" onClick={onClose} className="text-muted hover:text-text">
          <X size={14} />
        </button>
      </div>

      <div className="mt-3 space-y-1">
        {CATEGORIES.map((c) => (
          <label key={c.id} className="flex cursor-pointer items-center gap-2 py-1 text-sm">
            <input
              type="radio"
              name="category"
              value={c.id}
              checked={category === c.id}
              onChange={(e) => setCategory(e.target.value)}
              required
              className="accent-[rgb(var(--c-accent))]"
            />
            <span className={c.urgent ? 'text-danger' : ''}>{c.label}</span>
          </label>
        ))}
      </div>

      <textarea
        className="input mt-3 h-16 resize-none"
        placeholder="Anything else we should know (optional)"
        value={detail}
        maxLength={2000}
        onChange={(e) => setDetail(e.target.value)}
      />

      {state === 'error' && (
        <p className="mt-2 text-xs text-danger">Could not send that — try again.</p>
      )}

      <button type="submit" className="btn-primary mt-3 w-full" disabled={state === 'sending'}>
        {state === 'sending' && <Loader2 size={14} className="animate-spin" />}
        Send report
      </button>
    </form>
  )
}
