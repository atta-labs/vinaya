import type { CMSBranding } from '../types'

type IconEntry = { rel: 'icon'; type: string; url: string; sizes?: string }

export function buildFaviconIcons(branding: CMSBranding | null): IconEntry[] {
  if (!branding?.faviconIco?.url) return []
  return [{ rel: 'icon', type: 'image/x-icon', url: branding.faviconIco.url, sizes: '16x16 32x32 48x48' }]
}
