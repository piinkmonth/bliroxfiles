import type { Metadata } from 'next'
import { THEME_INIT_SCRIPT } from '@/components/theme'
import './globals.css'

export const metadata: Metadata = {
  title: 'blirox/files',
  description: 'invite-only file hosting.',
  robots: { index: false, follow: false },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Runs before first paint so the stored theme never flashes. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  )
}
