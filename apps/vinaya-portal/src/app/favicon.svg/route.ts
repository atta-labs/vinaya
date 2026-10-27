import { generateThemeCSSForScheme } from '@/cms'
import { getFaviconMarkup } from '@/lib/brand-logo'
import { getPortalCms } from '@/lib/portal-cms'

// The tab icon. A browser loads a favicon as a separate image, which never sees the page's
// CSS, so the CMS favicon SVG's `var(--background)`, `var(--foreground)` and `var(--ring)`
// would fall back to their defaults there. This route serves that SVG unchanged with the CMS
// theme's own variables written inside it — light by default, dark under the browser's
// `prefers-color-scheme: dark` — by the same renderer the page uses, so the icon follows the
// theme with nothing re-drawn. `favicon.ico` stays the fallback for browsers without SVG icons.
// The route is not cached by Next: the CMS read behind it is already cached (`getPortalCms`, the SVG
// fetch), and a failed read must not be kept — it answers 404 with `no-store`, so the browser falls
// back to the `.ico` and asks again next time.

export async function GET() {
  const { config, branding } = await getPortalCms()
  const markup = await getFaviconMarkup(branding)
  if (!markup) return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } })
  const theme = config?.userInterface?.theme
  const style = theme
    ? `<style>${generateThemeCSSForScheme(theme, 'light')}@media (prefers-color-scheme: dark) {${generateThemeCSSForScheme(theme, 'dark')}}</style>`
    : ''
  const svg = markup.replace(/<svg\b[^>]*>/, (open) => `${open}${style}`)
  return new Response(svg, {
    headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=300' }
  })
}
