import type { ReactNode } from 'react'
import { getLogoMarkup } from '@/lib/brand-logo'
import { getPortalCms } from '@/lib/portal-cms'
import { Footer } from '@/ui/footer'
import { NextLink } from '@/ui/lib/next-link'
import { Logo } from '@/ui/shared'
import { TopBar } from '@/ui/topbar'
import { DocsChromeProvider } from './_components/DocsChrome'
import { FooterGate } from './_components/FooterGate'
import { HeroLockup } from './_components/HeroLockup'
import { HeroLockupProvider } from './_components/hero-lockup-context'
import { SiteContentPad } from './_components/SiteContentPad'
import { SITE_LINKS } from './_components/site-nav'
import { TopBarChromeHost } from './_components/TopBarChromeHost'
import { DocsSearch } from './docs/_components/DocsSearch'
import './roadmap/marks-motion.css'
import { docsSearchIndex } from './docs/_lib/search-index'

// Vinaya's own topbar chrome, all of it carried here so the shared ChromeFrame stays
// untouched for every other consumer. Docked: glass, not a solid bar — `bg-background/35`
// lets the fabric show through, `backdrop-blur-md` keeps nav text legible over it.
// `border-transparent` is unconditional: Vinaya never wants a topbar border. Bare (landing
// cold-open, `data-bare="true"` on the `TopBarChromeHost` ancestor): no surface at all —
// background, shadow AND the backdrop blur all drop, so the canvas paints straight through
// the bar. The blur has to go too: over a transparent background it still smears the
// fabric's fine grid lines into a flat, bar-shaped band. The `[[data-bare=true]_&]:`
// ancestor selector outranks the plain utilities, so no order dependence. The docs shell's
// in-body bar has no `data-bare` ancestor, so it always reads docked.
const TOPBAR_CHROME_CLASS =
  'transform-gpu border-transparent bg-background/35 backdrop-blur-md [[data-bare=true]_&]:bg-transparent [[data-bare=true]_&]:shadow-none [[data-bare=true]_&]:backdrop-blur-none'

export default async function SiteLayout({ children }: { children: ReactNode }) {
  const { branding } = await getPortalCms()
  const logoUrl = branding?.logoSolidDark?.url ?? branding?.logoSolidLight?.url ?? null
  const logoMarkup = await getLogoMarkup(branding)

  // The docs shell's chrome (see `DocsShell`), built here beside the site-wide bar it replaces on docs routes. The
  // wordmark is the plain static `Logo` — the footer's lockup, not `HeroLockup`, whose nodes belong to the landing
  // hero's FLIP loop.
  const docsWordmark = (
    <NextLink href='/' variant='unstyled' className='flex items-center gap-2'>
      <Logo
        dark={logoUrl ?? undefined}
        markup={logoMarkup}
        alt='Vinaya'
        size='h-10'
        text={['Development', 'Harness']}
      />
    </NextLink>
  )
  // The docs bar is the landing page's own bar, logo included and links placed the same way.
  const docsTopStrip = (
    <TopBar
      logo={docsWordmark}
      chromeClassName={`${TOPBAR_CHROME_CLASS} @container/bar`}
      links={SITE_LINKS}
      withAuth={false}
      extraActions={<DocsSearch groups={docsSearchIndex()} />}
      colorSchemeToggle='end'
    />
  )

  // App-shell height: TopBarChromeHost is `fixed` (out of flow) so the hero section can
  // sit flush at the true page top and paint its canvas underneath the bar — that's what
  // lets `chromeClassName`'s transparency show fabric through it instead of blurring
  // nothing. `SiteContentPad` is the shell's one `h-dvh overflow-y-auto` scroll container
  // and also carries the `pt-14` that compensates for the bar on every route except
  // landing and the docs-shell routes (which get no fixed bar at all — see
  // `usesDocsShell`). It wraps `{children}` directly (`DocsChromeProvider` and
  // `FooterGate` render no DOM node), so pages that fill the viewport (the docs shells)
  // resolve `h-full` against it — a definite height — and scroll their own panes inside it.
  return (
    <HeroLockupProvider>
      {/* z-30 keeps the TopBar above the hero emblem's canvas (z-0). TopBarChromeHost
          also registers itself as the `bar` node the landing hero's lockup-flip loop
          writes `data-bare` onto — see `hero-lockup-context.tsx` for the mechanism. */}
      <TopBarChromeHost>
        <TopBar
          logo={
            // `lg:min-w-[10.75rem]` keeps the lockup's full width while it sits bare in the
            // hero, so the left-aligned links never jump when it flips into the bar.
            <NextLink href='/' variant='unstyled' className='flex items-center gap-2 lg:min-w-[10.75rem]'>
              <HeroLockup logoUrl={logoUrl} logoMarkup={logoMarkup} />
            </NextLink>
          }
          chromeClassName={TOPBAR_CHROME_CLASS}
          links={SITE_LINKS}
          withAuth={false}
          extraActions={<DocsSearch groups={docsSearchIndex()} />}
          colorSchemeToggle='end'
        />
      </TopBarChromeHost>
      <SiteContentPad>
        <DocsChromeProvider wordmark={docsWordmark} topStrip={docsTopStrip}>
          <FooterGate
            footer={
              // The portal's Footer as the portal renders it, minus its top rule (the shared package draws one).
              <div className='[&>footer]:border-t-0'>
                <Footer
                  product='vinaya'
                  logo={
                    <NextLink href='/' variant='unstyled' className='flex items-center gap-2'>
                      <Logo
                        dark={logoUrl ?? undefined}
                        markup={logoMarkup}
                        alt='Vinaya'
                        size='h-10'
                        text={['Development', 'Harness']}
                      />
                    </NextLink>
                  }
                  links={[
                    // the top bar's own items, in its order (Product has no page of its own: Home is the product), then npm
                    { label: 'Product', href: '/' },
                    { label: 'The Vinaya process', href: '/vinaya-process' },
                    { label: 'Docs', href: '/docs' },
                    { label: 'Config', href: '/configuration' },
                    { label: 'npm', href: 'https://www.npmjs.com/package/@attalabs/vinaya', external: true }
                  ]}
                />
              </div>
            }
          >
            {children}
          </FooterGate>
        </DocsChromeProvider>
      </SiteContentPad>
    </HeroLockupProvider>
  )
}
