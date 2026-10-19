'use client'

import { Moon, Sun } from 'lucide-react'
import { useEffect, useState } from 'react'
import { generateThemeCSSForScheme } from '@/cms'
import { Toggle } from '@/ui/components/toggle'
import { COLOR_SCHEME_ATTRIBUTE, COLOR_SCHEME_COOKIE_MAX_AGE, type ColorScheme, DEFAULT_SCHEME } from './color-scheme'
import { useCookieName } from './cookie-name-context'
import { useTheme } from './theme-context'

export function ColorSchemeToggle() {
  const cookieName = useCookieName()
  const [scheme, setScheme] = useState<ColorScheme>(DEFAULT_SCHEME)
  const { theme, styleId } = useTheme()

  useEffect(() => {
    const initial = document.documentElement.getAttribute(COLOR_SCHEME_ATTRIBUTE)
    if (initial === 'light' || initial === 'dark') setScheme(initial)
  }, [])

  function flip() {
    const next: ColorScheme = scheme === 'dark' ? 'light' : 'dark'

    // Swap the product theme style tag to the new scheme's vars
    if (theme && styleId) {
      const styleEl = document.getElementById(styleId)
      if (styleEl) styleEl.textContent = generateThemeCSSForScheme(theme, next)
    }

    document.documentElement.setAttribute(COLOR_SCHEME_ATTRIBUTE, next)
    // biome-ignore lint/suspicious/noDocumentCookie: Cookie Store API lacks Safari/Firefox support; document.cookie is the cross-browser write path
    document.cookie = `${cookieName}=${next}; Path=/; Max-Age=${COLOR_SCHEME_COOKIE_MAX_AGE}; SameSite=Lax`
    setScheme(next)
  }

  const Icon = scheme === 'dark' ? Sun : Moon
  const label = scheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'

  // `pressed` mirrors the scheme the flip already derives, and onPressedChange
  // calls the same flip(). A toggle button carries its state in `aria-pressed`,
  // so per the WAI-ARIA APG its name is static and names the thing toggled
  // ('Dark mode'), never the action; `title` stays action-phrased as the
  // sighted-user tooltip for what a click will do.
  return (
    <Toggle pressed={scheme === 'dark'} onPressedChange={flip} aria-label='Dark mode' title={label}>
      <Icon className='h-4 w-4' />
    </Toggle>
  )
}
