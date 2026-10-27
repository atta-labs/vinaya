'use client'

import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

type StickyDocHeaderProps = {
  /** The page title, always shown on the left of the bar. */
  title: string
  /** The headings that name the page's sections. */
  headingSelector?: string
  /**
   * How far below the scroll pane's top edge a heading still counts as
   * reached. Matches the headings' `scroll-mt-16`, so a deep-linked heading
   * lands just under the bar with the bar already naming it.
   */
  activeOffset?: number
}

/** One level of the bar: its text cross-fades when it changes. */
function Crumb({ text, strong }: { text: string; strong: boolean }) {
  return (
    <span className='relative min-w-0 shrink'>
      <AnimatePresence mode='wait' initial={false}>
        <motion.span
          key={text}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          className={`block truncate transition-colors ${strong ? 'font-medium text-foreground' : 'text-muted-foreground'}`}
        >
          {text}
        </motion.span>
      </AnimatePresence>
    </span>
  )
}

/**
 * A docs page's reading bar: once the title scrolls away it fades in, pinned
 * to the top of the pane, frosted over the text beneath, and names the
 * section and sub-section being read (up to three levels with the title). Each
 * level cross-fades as it changes.
 */
export function StickyDocHeader({
  title,
  headingSelector = '.doc-page-content h2, .doc-page-content h3',
  activeOffset = 64
}: StickyDocHeaderProps) {
  const [shown, setShown] = useState(false)
  // The docs pane's full-width slot (`(guide)/layout.tsx`), so the bar spans the pane rather than the article.
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  useEffect(() => setSlot(document.getElementById('doc-sticky-slot')), [])
  const [active, setActive] = useState<{ section: string | null; sub: string | null }>({
    section: null,
    sub: null
  })

  useEffect(() => {
    const pane = document.querySelector('main')
    if (!pane) return
    const onScroll = () => {
      const top = pane.getBoundingClientRect().top
      setShown(pane.scrollTop > 120)
      // The last `h2` reached is the section; the last `h3` reached after it, the sub-section.
      let section: string | null = null
      let sub: string | null = null
      for (const heading of pane.querySelectorAll(headingSelector)) {
        if (heading.getBoundingClientRect().top - top > activeOffset) break
        if (heading.tagName === 'H2') {
          section = heading.textContent
          sub = null
        } else sub = heading.textContent
      }
      setActive((prev) => (prev.section === section && prev.sub === sub ? prev : { section, sub }))
    }
    pane.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => pane.removeEventListener('scroll', onScroll)
  }, [headingSelector, activeOffset])

  const bar = (
    // `h-0 overflow-visible`: the bar overlays the page and never takes flow height.
    <div
      aria-hidden={!shown}
      className={`sticky top-0 z-20 h-0 overflow-visible ${shown ? '' : 'pointer-events-none'}`}
    >
      {/* The fade sits on the frosted element itself, never on an ancestor: an ancestor below full opacity cuts the
          blur off from the page behind it, so the frost would vanish while it fades. `transform-gpu` keeps the frost
          on its own layer while the pane scrolls beneath it. */}
      <div
        className={`h-12 transform-gpu bg-background/70 font-sans text-sm backdrop-blur-md transition-opacity duration-300 supports-[backdrop-filter]:bg-background/60 ${
          shown ? 'opacity-100' : 'opacity-0'
        }`}
      >
        {/* The article's own box (`(guide)/layout.tsx`), so the crumbs start where the text starts. */}
        <div className='mx-auto flex h-full max-w-[54rem] items-center gap-2 px-6 lg:px-12'>
          <span className='max-w-[40%] shrink-0 truncate text-muted-foreground'>{title}</span>
          <span className='text-muted-foreground/40' aria-hidden>
            /
          </span>
          <Crumb text={active.section ?? 'Overview'} strong={!active.sub} />
          <AnimatePresence initial={false}>
            {active.sub && (
              <motion.span
                key='sub'
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
                className='flex min-w-0 items-center gap-2'
              >
                <span className='text-muted-foreground/40' aria-hidden>
                  /
                </span>
                <Crumb text={active.sub} strong />
              </motion.span>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
  return slot ? createPortal(bar, slot) : bar
}
