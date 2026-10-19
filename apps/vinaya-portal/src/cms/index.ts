// @atta/cms — Sanity CMS client, types, queries, and theme utilities

// Client
export { createProductClient } from './client'
export { getProductBranding } from './queries/branding'
export { getProductCms, type ProductCms } from './queries/product-cms'
// Queries
export { getRoadmapMilestones, type RoadmapMilestone } from './queries/roadmap-milestones'
export { getThemeById } from './queries/theme'
// Types
export type { CMSBranding, CMSTheme, PortalUiConfig } from './types'

// Utils
export { buildFaviconIcons } from './utils/favicon'
export { getGoogleFontsUrl, loadThemeFonts } from './utils/font-loader'
export { generateThemeCSS, generateThemeCSSForScheme } from './utils/theme'
