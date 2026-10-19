'use client'

import { ArrowLeft, ArrowRight } from 'lucide-react'
import { usePathname } from 'next/navigation'
import { NextLink } from '@/ui/lib/next-link'
import { pageNeighbours } from '../_lib/portal-docs'

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
          <span className='font-sans text-base text-foreground'>{prev.title}</span>
        </NextLink>
      ) : (
        <span className='hidden flex-1 sm:block' />
      )}
      {next && (
        <NextLink variant='unstyled' href={next.href} className={`${card} items-end text-right`}>
          <span className='flex items-center gap-1 font-mono text-xs uppercase tracking-widest text-muted-foreground'>
            Next <ArrowRight className='size-3' aria-hidden />
          </span>
          <span className='font-sans text-base text-foreground'>{next.title}</span>
        </NextLink>
      )}
    </nav>
  )
}
