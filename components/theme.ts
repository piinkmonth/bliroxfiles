export interface Theme {
  id: string
  label: string
  mode: 'dark' | 'light'
  /** Swatch colours for the picker: [bg, surface, accent]. */
  swatch: [string, string, string]
}

/**
 * The palettes offered in the picker. Each has a matching block in
 * globals.css keyed by `data-theme`; adding one back is an entry here plus that
 * block. The default is `ash` — a warm amber accent read against the cold snow,
 * which is the look the CSS comments describe as intended.
 *
 * `moss` and `paper` still have CSS blocks but are held out of the picker to
 * keep the set curated; drop them back in here to offer them.
 */
export const THEMES: Theme[] = [
  { id: 'ash', label: 'Ash', mode: 'dark', swatch: ['#0a0a0a', '#161514', '#d97706'] },
  { id: 'ember', label: 'Ember', mode: 'dark', swatch: ['#0d0a09', '#1a1412', '#c2410c'] },
  { id: 'slate', label: 'Slate', mode: 'dark', swatch: ['#0c0d0e', '#17191b', '#e2e7eb'] },
  { id: 'bone', label: 'Bone', mode: 'light', swatch: ['#f2efe9', '#faf8f3', '#b45f08'] },
]

export const DEFAULT_THEME = 'ash'
export const THEME_STORAGE_KEY = 'blirox-theme'

export function isValidTheme(id: string | null | undefined): boolean {
  return !!id && THEMES.some((t) => t.id === id)
}

/**
 * Inlined into <head> so the stored theme is applied before first paint.
 * Without this the page renders in the default palette and then snaps to the
 * user's choice — the classic dark-mode flash.
 */
export const THEME_INIT_SCRIPT = `
(function() {
  try {
    var stored = localStorage.getItem('${THEME_STORAGE_KEY}');
    var valid = ${JSON.stringify(THEMES.map((t) => t.id))};
    var theme = valid.indexOf(stored) !== -1 ? stored : '${DEFAULT_THEME}';
    document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {
    document.documentElement.setAttribute('data-theme', '${DEFAULT_THEME}');
  }
})();
`.trim()
