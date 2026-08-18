'use client'

import { useEffect, useState } from 'react'
import { Check, Palette } from 'lucide-react'
import { THEMES, DEFAULT_THEME, THEME_STORAGE_KEY, isValidTheme } from './theme'

export function ThemePicker({ compact = false }: { compact?: boolean }) {
  const [theme, setTheme] = useState(DEFAULT_THEME)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    if (isValidTheme(stored)) setTheme(stored!)
    // Colour transitions are suppressed until now so the initial paint is clean.
    document.documentElement.classList.add('theme-ready')
  }, [])

  function apply(id: string) {
    setTheme(id)
    localStorage.setItem(THEME_STORAGE_KEY, id)
    document.documentElement.setAttribute('data-theme', id)
    setOpen(false)
  }

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('[data-theme-picker]')) setOpen(false)
    }
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [open])

  // Nothing to pick between; render nothing rather than a dead control.
  if (THEMES.length < 2) return null

  return (
    <div className="relative" data-theme-picker>
      <button
        onClick={() => setOpen((v) => !v)}
        className="btn-ghost"
        aria-label="Change theme"
        aria-expanded={open}
      >
        <Palette size={16} />
        {!compact && <span>Theme</span>}
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-56 animate-fade-up rounded-card border border-border bg-surface p-1.5 shadow-2xl">
          {THEMES.map((t) => (
            <button
              key={t.id}
              onClick={() => apply(t.id)}
              className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-raised"
            >
              <span className="flex shrink-0 overflow-hidden rounded-md border border-border">
                {t.swatch.map((c, i) => (
                  <span key={i} style={{ background: c }} className="h-5 w-3" />
                ))}
              </span>
              <span className="flex-1">{t.label}</span>
              {theme === t.id && <Check size={15} className="text-accent" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
