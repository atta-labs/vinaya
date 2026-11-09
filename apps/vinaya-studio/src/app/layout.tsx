import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { buildFaviconIcons } from '@vinaya/cms'
import { NextWebShell } from '@vinaya/ui/server'
import { getStudioCms } from '@/lib/studio-cms'
import { StudioHeader } from '@/ui/header'
import '@/ui/styles/studio.css'

// The theme is read from the CMS on every request, never baked in at build time.
export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  const { branding } = await getStudioCms()
  return {
    title: 'Vinaya Studio',
    description: "Watch this repository's tasks from its Log, on your own machine.",
    icons: buildFaviconIcons(branding)
  }
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const { config, branding } = await getStudioCms()
  return (
    <NextWebShell
      config={config}
      branding={branding}
      styleId='vinaya-studio-theme'
      cookieName='vinaya-studio-color-scheme'
    >
      <StudioHeader />
      <main className='mx-auto w-full max-w-7xl px-6 py-8'>{children}</main>
    </NextWebShell>
  )
}
