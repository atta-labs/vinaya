import 'server-only'
import { cache } from 'react'
import { getProductCms, type ProductCms } from '@vinaya/cms'

/**
 * The one CMS read for this app: Studio's config and branding under its own product key, `vinayaStudio`. Read on
 * every request (the root layout is dynamic), deduped within one render by `cache()`, so a theme changed in the CMS
 * shows on the next page load. When the CMS cannot be reached, `getProductCms` returns no config and the page
 * renders unthemed — there is no fallback theme.
 */
export const getStudioCms = cache(async (): Promise<ProductCms> => getProductCms('vinayaStudio'))
