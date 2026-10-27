import 'server-only'
import type { CMSBranding } from '@/cms'
import { sanitizeSvg } from '@/app/(site)/roadmap/_lib/sanitize-svg'

// The logo is the CMS branding's solid SVG, inlined into the page rather than shown
// through an `<img>`: inlined, its `var(--foreground)` and `var(--ring)` read the live
// theme, so the second colour follows whatever theme the CMS sets. Inlining CMS markup
// is the same injection surface as a roadmap mark, so it goes through the same sanitizer.
const LOGO_HOST = 'cdn.sanity.io'
const MAX_SVG_BYTES = 256 * 1024
const FETCH_TIMEOUT_MS = 5000

async function fetchCmsSvg(url: string): Promise<string | null> {
  try {
    const parsed = new URL(url)
    const onCdn =
      parsed.protocol === 'https:' &&
      parsed.hostname === LOGO_HOST &&
      parsed.port === '' &&
      parsed.pathname.endsWith('.svg')
    if (!onCdn) return null
    const res = await fetch(url, {
      cache: 'force-cache',
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('image/svg+xml')) return null
    const body = await res.text()
    return body.length > MAX_SVG_BYTES ? null : body
  } catch {
    return null
  }
}

export async function getLogoMarkup(branding: CMSBranding | null): Promise<string | null> {
  const url = branding?.logoSolidDark?.url ?? branding?.logoSolidLight?.url
  const body = url ? await fetchCmsSvg(url) : null
  if (!body) return null
  const markup = sanitizeSvg(body)
  return markup.includes('<svg') ? markup : null
}
