import { Analytics } from '@vercel/analytics/next'
import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { buildFaviconIcons } from '@/cms'
import { getPortalCms } from '@/lib/portal-cms'
import { NextWebShell } from '@/ui/lib/next-web-shell'
import { PreviewThemeListener } from '@/ui/lib/preview-theme-listener'
import '@/ui/styles/globals.css'

export async function generateMetadata(): Promise<Metadata> {
  const { branding } = await getPortalCms()
  return {
    title: 'Vinaya Development Harness',
    description:
      'A development process teams can govern: coding agents on planned tasks, checked by machine before merge.',
    icons: buildFaviconIcons(branding)
  }
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const { config, branding } = await getPortalCms()
  return (
    <NextWebShell
      config={config}
      branding={branding}
      styleId='vinaya-theme'
      cookieName='vinaya-color-scheme'
      staticColorScheme
    >
      <PreviewThemeListener />
      {children}
      {/* Vercel serves the analytics script only on its own deployments; elsewhere it would 404. */}
      {process.env.VERCEL ? <Analytics /> : null}
    </NextWebShell>
  )
}
