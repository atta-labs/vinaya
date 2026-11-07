// @vinaya/cms — Sanity CMS client, types, queries, and theme utilities

// Client
export { createProductClient, type ProductKey } from './client'
export { getProductBranding } from './queries/branding'
export { getProductCms, type ProductCms } from './queries/product-cms'
// Queries
export { getProductConfig } from './queries/product-ui-config'
export { getThemeById } from './queries/theme'
// Types
export type { CMSBranding, CMSTheme, PortalUiConfig } from './types'

// Utils
export { toCssDeclarations } from './utils/css-safety'
export { buildFaviconIcons } from './utils/favicon'
export { getGoogleFontsUrl, loadThemeFonts } from './utils/font-loader'
export { cssColorToOklch } from './utils/oklch'
export { generateThemeCSS, generateThemeCSSForScheme } from './utils/theme'
