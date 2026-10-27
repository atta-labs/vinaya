import { generateThemeCSSForScheme } from '@/cms'
import { getFaviconMarkup } from '@/lib/brand-logo'
import { getPortalCms } from '@/lib/portal-cms'

// The tab icon. A browser loads a favicon as a separate image, which never sees the page's
// CSS, so the CMS favicon SVG's `var(--background)`, `var(--foreground)` and `var(--ring)`
// would fall back to their defaults there. This route serves that SVG unchanged with the CMS
// theme's own variables written inside it — light by default, dark under the browser's
// `prefers-color-scheme: dark` — by the same renderer the page uses, so the icon follows the
// theme with nothing re-drawn. `favicon.ico` stays the fallback for browsers without SVG icons.
export const revalidate = 60

export async function GET() {
  const { config, branding } = await getPortalCms()
  const markup = await getFaviconMarkup(branding)
  if (!markup) return new Response(null, { status: 404 })
  const theme = config?.userInterface?.theme
  const style = theme
    ? `<style>${generateThemeCSSForScheme(theme, 'light')}@media (prefers-color-scheme: dark) {${generateThemeCSSForScheme(theme, 'dark')}}</style>`
    : ''
  const svg = markup.replace(/<svg\b[^>]*>/, (open) => `${open}${style}`)
  return new Response(svg, {
    headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=300' }
  })
}
