'use client'

import { useEffect, useState } from 'react'
import { cachedKey, decryptString, lockedFolderLabel } from '@/lib/e2e'

/**
 * Render a folder's name, decrypting it when this tab holds the key.
 *
 * An encrypted folder's `name` column is ciphertext. Decryption is async and
 * happens only in the browser, so the first paint shows the locked placeholder
 * and swaps once the key has been applied — there is no way to render the real
 * name server-side, which is the entire point.
 */
export function FolderName({
  id,
  name,
  encrypted,
}: {
  id: string
  name: string
  /** Optional so breadcrumb entries can omit it for plain folders. */
  encrypted?: boolean | number
}) {
  const isEncrypted = !!encrypted
  const [label, setLabel] = useState(isEncrypted ? lockedFolderLabel(id) : name)

  useEffect(() => {
    if (!isEncrypted) {
      setLabel(name)
      return
    }

    let cancelled = false
    const key = cachedKey(id)
    if (!key) {
      setLabel(lockedFolderLabel(id))
      return
    }

    decryptString(name, key).then((plain) => {
      // The component may have unmounted, or navigated to another folder,
      // while the decrypt was in flight.
      if (!cancelled) setLabel(plain ?? lockedFolderLabel(id))
    })

    return () => {
      cancelled = true
    }
  }, [id, name, isEncrypted])

  return <>{label}</>
}
