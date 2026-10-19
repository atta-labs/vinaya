import type { ReactNode } from 'react'
import { NextLink } from '@/ui/lib/next-link'
import { Logo } from '@/ui/shared'
import { TopBar } from '@/ui/topbar'
import { SITE_LINKS } from './site-nav'

/**
 * The site's bar for full-screen pages outside the site layout (the Vinaya
 * process demo and diagram): the static lockup, the site nav, and the search.
 */
export function PortalBar({ logoUrl, search }: { logoUrl: string | null; search?: ReactNode }) {
  return (
    <TopBar
      withAuth={false}
      chromeClassName='border-transparent bg-transparent'
      logo={
        <NextLink href='/' variant='unstyled' className='flex items-center gap-2'>
          <Logo dark={logoUrl ?? undefined} alt='Vinaya' size='h-10' text={['Development', 'Harness']} />
        </NextLink>
      }
      links={SITE_LINKS}
      extraActions={search}
      colorSchemeToggle='end'
    />
  )
}
