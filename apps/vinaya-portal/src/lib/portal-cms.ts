import 'server-only'
import { unstable_cache } from 'next/cache'
import { cache } from 'react'
import { createProductClient, getProductCms, getThemeById, type ProductCms } from '@/cms'

const REVALIDATE_SECONDS = 60

/**
 * `getProductCms('vinayaPortal')`'s underlying `getProductUiConfig` deliberately
 * bypasses Sanity's CDN (`packages/cms/src/queries/product-ui-config.ts`) so a
 * change made in the CMS admin is visible immediately. Without forced dynamic
 * rendering, "immediately" means a live Sanity round-trip on every request — and
 * this app has two independent call sites that would pay that cost per render
 * (the root layout and `(site)/layout.tsx` each call `getProductCms`).
 *
 * `unstable_cache` trades that immediacy for a `REVALIDATE_SECONDS` staleness
 * window — the right tradeoff for a public marketing site. It wraps the whole
 * `getProductCms` call rather than passing `next: { revalidate }` through to
 * `@sanity/client`'s own `.fetch()`: that per-call option is real and does get
 * read by `@sanity/client` (`_fetch` in `node_modules/@sanity/client/dist/index.js`
 * folds `cache`/`next` into a `fetch` options bag that `get-it`'s node adapter
 * then routes through the global `fetch()` — Next's own patched one, in a
 * Next.js request scope — instead of its default `http`/`https` adapter), but
 * neither `getProductUiConfig` nor `getProductBranding` (`packages/cms`) expose
 * a way for a caller to pass it in. Wrapping the call at this app boundary gets the same caching
 * outcome without touching the package.
 *
 * Exported unwrapped so tests can call it directly without a Next.js request
 * scope, which `unstable_cache`/`cache()` require — same shape as
 * `fetchPublishedReleaseMetrics` in `./published-release-metrics.ts`.
 */
async function fetchPortalCms(): Promise<ProductCms> {
  const cms = await getProductCms('vinayaPortal')
  return withThemeOverride(cms)
}

/**
 * This app's own look, without touching the CMS config the live portal reads:
 * `PORTAL_THEME_ID` names any `uiTheme` in the Atta Labs project (`theme-factory`,
 * say) and `PORTAL_COLOR_SCHEME` picks `light` or `dark`. Unset, the CMS config wins.
 */
async function withThemeOverride(cms: ProductCms): Promise<ProductCms> {
  const themeId = process.env.PORTAL_THEME_ID
  const scheme = process.env.PORTAL_COLOR_SCHEME
  const config = cms.config
  const ui = config?.userInterface
  if (!config || !ui || (!themeId && !scheme)) return cms
  const theme = themeId ? await getThemeById(createProductClient('attalabs', { useCdn: false }), themeId) : null
  return {
    ...cms,
    config: {
      ...config,
      userInterface: {
        ...ui,
        theme: theme ?? ui.theme,
        colorScheme: scheme === 'light' || scheme === 'dark' ? scheme : ui.colorScheme
      }
    }
  }
}

const getCachedPortalCms = unstable_cache(fetchPortalCms, ['vinaya-portal-cms'], {
  revalidate: REVALIDATE_SECONDS
})

/**
 * The one CMS read for this app. `src/app/layout.tsx` (render + metadata) and
 * `src/app/(site)/layout.tsx` all call this instead of
 * `getProductCms('vinayaPortal')` directly, so a render makes one revalidate-windowed,
 * request-deduped (`cache()`) read instead of up to three independent live Sanity
 * round-trips.
 */
export const getPortalCms = cache(getCachedPortalCms)
