import '@ejc3/claw-master-dashboard/styles.css'
import './globals.css'

import type { Metadata, Viewport } from 'next'
import { Rubik } from 'next/font/google'
import type { ReactNode } from 'react'
import { RESTYLE_SCRIPT } from '@/lib/restyle'

const sans = Rubik({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--cmd-font-sans',
})

export const metadata: Metadata = {
  title: 'claw-master',
  description: 'Subscription headroom, resets and traffic for a claw-master pool.',
  robots: { index: false, follow: false },
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#faf9fb' },
    { media: '(prefers-color-scheme: dark)', color: '#1a141f' },
  ],
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={sans.variable}>
      <body>
        {children}
        {/* Reloads once if the stylesheet did not apply (lib/restyle.ts). */}
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: our own constant script */}
        <script dangerouslySetInnerHTML={{ __html: RESTYLE_SCRIPT }} />
      </body>
    </html>
  )
}
