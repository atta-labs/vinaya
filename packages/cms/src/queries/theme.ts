/**
 * Theme queries — GROQ queries for reading themes from Sanity.
 */

import type { SanityClient } from '@sanity/client'
import type { CMSTheme } from '../types'

const THEME_PROJECTION = `{
  _id,
  name,
  light,
  dark,
  typography,
  spacing,
  shadows,
  neobrutalist
}`

/** Fetch a single theme by ID */
export async function getThemeById(client: SanityClient, themeId: string): Promise<CMSTheme | null> {
  return client.fetch(`*[_type == "uiTheme" && _id == $themeId][0] ${THEME_PROJECTION}`, { themeId })
}
