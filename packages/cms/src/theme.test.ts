import { describe, expect, test } from 'bun:test'
import { type CMSTheme, SHADOW_TO_CSS_VAR } from './types'
import corpus from './utils/theme-corpus.fixture.json'
import recorded from './utils/theme-corpus.rendered.fixture.json'
import { generateThemeCSS, generateThemeCSSForScheme } from './utils/theme'

/**
 * The recorded theme corpus — every value and every colour field name the
 * shipped theme documents use — folded into themes: each theme takes the next
 * run of values for its colour fields (light as plain strings, dark in the
 * legacy `{ value }` form), and the same run feeds typography, spacing and the
 * shadow ramp. Every corpus value reaches the renderer at least once.
 *
 * `theme-corpus.rendered.fixture.json` is what the renderer produced for these
 * themes when it lived in the portal, recorded before it moved into this
 * package. Any difference is a change in the CSS every Vinaya web app renders.
 */
function corpusThemes(): CMSTheme[] {
  const values: string[] = corpus.values
  const fields: string[] = corpus.colorFieldNames
  const shadowKeys = Object.keys(SHADOW_TO_CSS_VAR)
  const at = (i: number) => values[i % values.length] as string

  const themes: CMSTheme[] = []
  for (let start = 0; start < values.length; start += fields.length) {
    const light: Record<string, string> = {}
    const dark: Record<string, { value: string }> = {}
    fields.forEach((field, i) => {
      light[field] = at(start + i)
      dark[field] = { value: at(start + i + 1) }
    })
    themes.push({
      _id: `corpus-${start}`,
      name: `corpus-${start}`,
      light,
      dark,
      typography: {
        fontSans: at(start),
        fontSerif: at(start + 1),
        fontMono: at(start + 2),
        trackingNormal: at(start + 3)
      },
      spacing: { radius: at(start + 4), spacing: at(start + 5) },
      shadows: Object.fromEntries(shadowKeys.map((key, i) => [key, at(start + 6 + i)]))
    })
  }
  return themes
}

describe('the theme renderer on the recorded corpus', () => {
  const themes = corpusThemes()

  test('covers every recorded theme', () => {
    expect(themes.length).toBe(recorded.rendered.length)
  })

  test.each(themes.map((theme, i) => [theme._id, theme, recorded.rendered[i]] as const))(
    '%s renders the CSS recorded before the move',
    (_id, theme, expected) => {
      expect(generateThemeCSS(theme)).toBe(expected?.both as string)
      expect(generateThemeCSSForScheme(theme, 'light')).toBe(expected?.light as string)
      expect(generateThemeCSSForScheme(theme, 'dark')).toBe(expected?.dark as string)
    }
  )
})
