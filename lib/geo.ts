/**
 * Country display helpers.
 *
 * Two-letter ISO 3166-1 alpha-2 codes are what Cloudflare hands us and what
 * gets stored; everything user-facing goes through here so a code is never
 * rendered raw in one place and as a name in another.
 *
 * Safe on both sides of the wire: `Intl.DisplayNames` is in Node and in every
 * browser this app supports, and the flag is derived arithmetically rather
 * than from a table.
 */

/** "GB" → "United Kingdom". Falls back to the code itself. */
export function countryName(code: string | null | undefined): string {
  if (!code) return 'Unknown'
  try {
    return new Intl.DisplayNames(undefined, { type: 'region' }).of(code) ?? code
  } catch {
    return code
  }
}

/**
 * "GB" → 🇬🇧, by mapping each letter onto its regional indicator symbol.
 *
 * A platform without flag glyphs renders the two indicator letters instead,
 * which still reads as the country code rather than as tofu.
 */
export function countryFlag(code: string | null | undefined): string {
  if (!code || !/^[A-Za-z]{2}$/.test(code)) return '🏳️'
  return String.fromCodePoint(
    ...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65),
  )
}

/** "🇬🇧 United Kingdom", or "Unknown" when there is no code. */
export function countryLabel(code: string | null | undefined): string {
  if (!code) return 'Unknown'
  return `${countryFlag(code)} ${countryName(code)}`
}
