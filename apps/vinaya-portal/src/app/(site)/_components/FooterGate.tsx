'use client'

import { usePathname } from 'next/navigation'
import { createContext, type ReactNode, useContext } from 'react'

type FooterPlacement = 'content' | 'hidden' | 'site'

/**
 * Every `/docs` page renders in the docs shell, which owns its own scroll pane, so the
 * footer goes inside that pane rather than after the whole shell. Everywhere else it is
 * the site footer.
 */
function footerPlacement(pathname: string): FooterPlacement {
  if (pathname.startsWith('/docs/')) return 'content'
  return 'site'
}

const FooterContext = createContext<ReactNode>(null)

export function FooterGate({ children, footer }: { children: ReactNode; footer: ReactNode }) {
  const placement = footerPlacement(usePathname() ?? '')

  return (
    <FooterContext.Provider value={footer}>
      {children}
      {placement === 'site' ? footer : null}
    </FooterContext.Provider>
  )
}

/** Renders the site footer in a nested layout's own content scroll pane. */
export function FooterContentSlot() {
  const footer = useContext(FooterContext)
  return <>{footer}</>
}
