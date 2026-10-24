'use client'

import { ArrowLeft, ArrowRight } from 'lucide-react'
import { usePathname } from 'next/navigation'
import { NextLink } from '@/ui/lib/next-link'
import { iconForPage, SMALL_ICON } from '../../_components/icons'
import { type DocsPage, pageNeighbours } from '../_lib/portal-docs'

/** A neighbour's title, with the icon of the element it names. */
function PageName({ page, end }: { page: DocsPage; end?: boolean }) {
  const Icon = iconForPage(page)
  return (
    <span className={`flex items-center gap-2 font-sans text-base text-foreground ${end ? 'justify-end' : ''}`}>
      {Icon && <Icon className={SMALL_ICON} still />}
      {page.title}
    </span>
  )
}

/** The previous and next page in reading order, at the end of every docs page. */
export function DocsPager() {
  const { prev, next } = pageNeighbours(usePathname() ?? '')
  const card =
    'flex flex-1 flex-col gap-1 rounded-lg border border-border p-4 transition-colors hover:border-foreground'
  return (
    <nav aria-label='Pages' className='mt-16 flex flex-col gap-3 border-t border-border pt-8 sm:flex-row'>
      {prev ? (
        <NextLink variant='unstyled' href={prev.href} className={card}>
          <span className='flex items-center gap-1 font-mono text-xs uppercase tracking-widest text-muted-foreground'>
            <ArrowLeft className='size-3' aria-hidden /> Previous
          </span>
          <PageName page={prev} />
        </NextLink>
      ) : (
        <span className='hidden flex-1 sm:block' />
      )}
      {next && (
        <NextLink variant='unstyled' href={next.href} className={`${card} items-end text-right`}>
          <span className='flex items-center gap-1 font-mono text-xs uppercase tracking-widest text-muted-foreground'>
            Next <ArrowRight className='size-3' aria-hidden />
          </span>
          <PageName page={next} end />
        </NextLink>
      )}
    </nav>
  )
}
