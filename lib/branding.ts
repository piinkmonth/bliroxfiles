import fs from 'node:fs'
import path from 'node:path'

/**
 * Locate a logo file dropped into public/.
 *
 * Checked once at module load. Drop a file at public/logo.svg (or .png/.webp)
 * and it replaces the built-in letterform everywhere — no code change, just a
 * restart. Order is preference order: vector first, then lossless raster.
 */
const CANDIDATES = ['logo.svg', 'logo.png', 'logo.webp', 'logo.jpg']

function findLogo(): string | null {
  for (const name of CANDIDATES) {
    if (fs.existsSync(path.join(process.cwd(), 'public', name))) {
      return `/${name}`
    }
  }
  return null
}

export const LOGO_SRC: string | null = findLogo()

export const BRAND = {
  name: 'blirox/files',
  short: 'blirox',
  suffix: 'files',
}
