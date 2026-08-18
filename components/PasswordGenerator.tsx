'use client'

import { useState, useCallback } from 'react'
import { RefreshCw, Copy, Check, Eye, EyeOff } from 'lucide-react'

/**
 * Passphrase generator for encrypted folders.
 *
 * Word-based rather than a random character soup, because an encrypted folder
 * password is unrecoverable: if it is lost the contents are gone permanently,
 * with no reset. A passphrase someone can actually write down and re-type is
 * worth more here than one with marginally higher entropy that they will
 * paste once and then lose.
 *
 * Seven words from this 128-word list is 7 × 7 = 49 bits, which is plenty
 * against an offline attack on a key derived with a slow KDF.
 */
const WORDS = [
  'amber', 'anchor', 'ancient', 'arctic', 'atlas', 'aurora', 'autumn', 'basalt',
  'beacon', 'birch', 'bishop', 'bramble', 'bronze', 'canyon', 'cedar', 'cinder',
  'cobalt', 'comet', 'compass', 'copper', 'coral', 'crater', 'crimson', 'crystal',
  'dagger', 'delta', 'dusk', 'ember', 'evening', 'falcon', 'fathom', 'ferry',
  'flint', 'forest', 'fossil', 'frost', 'garnet', 'glacier', 'granite', 'harbor',
  'harvest', 'hazel', 'hollow', 'horizon', 'indigo', 'iron', 'island', 'ivory',
  'jasper', 'juniper', 'kestrel', 'lantern', 'lattice', 'ledger', 'linen', 'lunar',
  'marble', 'meadow', 'meridian', 'midnight', 'mineral', 'mirror', 'monsoon', 'mortar',
  'nettle', 'nimbus', 'north', 'oaken', 'obsidian', 'ochre', 'onyx', 'orbit',
  'otter', 'painter', 'pebble', 'pewter', 'pigeon', 'pillar', 'pine', 'plateau',
  'polar', 'prairie', 'quarry', 'quartz', 'quiet', 'raven', 'ridge', 'river',
  'rooster', 'rust', 'saffron', 'sable', 'sandbar', 'sapling', 'scarlet', 'shale',
  'shelter', 'signal', 'silver', 'slate', 'solstice', 'spruce', 'starling', 'station',
  'stellar', 'stone', 'summit', 'sundial', 'talon', 'tamarind', 'tangent', 'tavern',
  'temple', 'thistle', 'thunder', 'timber', 'tundra', 'umbra', 'valley', 'velvet',
  'vessel', 'walnut', 'warden', 'willow', 'window', 'winter', 'yarrow', 'zenith',
]

/** Uniform pick — modulo on a random byte would bias toward low indices. */
function pickWord(): string {
  const range = 256 - (256 % WORDS.length)
  const buf = new Uint8Array(1)
  for (;;) {
    crypto.getRandomValues(buf)
    if (buf[0] < range) return WORDS[buf[0] % WORDS.length]
  }
}

export function generatePassphrase(words = 7): string {
  return Array.from({ length: words }, pickWord).join('-')
}

export function PasswordGenerator({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  const [copied, setCopied] = useState(false)
  const [visible, setVisible] = useState(true)

  const regenerate = useCallback(() => onChange(generatePassphrase()), [onChange])

  return (
    <div>
      <div className="flex gap-2">
        <input
          type={visible ? 'text' : 'password'}
          className="input font-mono text-xs"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="click generate, or type your own"
          autoComplete="new-password"
          spellCheck={false}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="btn-ghost shrink-0"
          title={visible ? 'Hide' : 'Show'}
        >
          {visible ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
        <button type="button" onClick={regenerate} className="btn-ghost shrink-0" title="Generate">
          <RefreshCw size={14} />
        </button>
        <button
          type="button"
          className="btn-ghost shrink-0"
          title="Copy"
          disabled={!value}
          onClick={() => {
            navigator.clipboard.writeText(value)
            setCopied(true)
            setTimeout(() => setCopied(false), 1600)
          }}
        >
          {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
        </button>
      </div>

      <p className="mt-2 border-l-2 border-warn pl-3 text-xs leading-relaxed text-muted">
        <strong className="text-text">Write this down before you continue.</strong> The key is
        derived in your browser and never reaches the server, so nobody — including whoever runs
        this site — can recover it. Lose the passphrase and the folder&rsquo;s contents are gone
        permanently.
      </p>
    </div>
  )
}
