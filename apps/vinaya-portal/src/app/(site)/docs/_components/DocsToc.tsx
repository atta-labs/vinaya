'use client'

import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { NextLink } from '@/ui/lib/next-link'
import { cn } from '@/ui/lib/utils'

type Heading = { id: string; text: string }

/** "On this page": the article's section headings, the one in view marked as the reader scrolls. */
export function DocsToc() {
  const pathname = usePathname()
  const [headings, setHeadings] = useState<Heading[]>([])
  const [active, setActive] = useState<string | null>(null)

  useEffect(() => {
    const found = [...document.querySelectorAll<HTMLElement>('[data-doc-article] h2[id]')].map((h) => ({
      id: h.id,
      text: h.textContent ?? ''
    }))
    setHeadings(found)
    const pane = document.querySelector('main')
    if (!pane) return
    const onScroll = () => {
      const top = pane.getBoundingClientRect().top
      let current = found[0]?.id ?? null
      for (const h of found) {
        const el = document.getElementById(h.id)
        if (el && el.getBoundingClientRect().top - top <= 96) current = h.id
      }
      // A short last section never reaches the top; at the pane's end it is the one in view.
      if (pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 2) current = found.at(-1)?.id ?? current
      setActive(current)
    }
    onScroll()
    pane.addEventListener('scroll', onScroll)
    return () => pane.removeEventListener('scroll', onScroll)
  }, [pathname])

  if (headings.length < 2) return null
  return (
    <nav aria-label='On this page' className='flex flex-col gap-3'>
      <p className='font-mono text-xs uppercase tracking-widest text-muted-foreground'>On this page</p>
      <ul className='flex flex-col border-l border-border'>
        {headings.map((h) => (
          <li key={h.id}>
            <NextLink
              href={`#${h.id}`}
              variant='unstyled'
              className={cn(
                '-ml-px block border-l py-1 pl-3 font-sans text-sm transition-colors',
                active === h.id
                  ? 'border-foreground text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              )}
            >
              {h.text}
            </NextLink>
          </li>
        ))}
      </ul>
    </nav>
  )
}
