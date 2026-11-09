'use client'

import { usePathname } from 'next/navigation'
import { ColorSchemeToggle, NextLink, Text } from '@vinaya/ui'
import { isOnScreen, STUDIO_SCREENS } from './screens'

/** Studio's own header: its name, its three screens and the colour-scheme switch. */
export function StudioHeader() {
  const pathname = usePathname()
  return (
    <header className='border-b border-border bg-[var(--header-background)]'>
      <div className='mx-auto flex w-full max-w-7xl items-center gap-8 px-6 py-3'>
        <Text as='span' family='mono' weight='semibold'>
          Vinaya Studio
        </Text>
        <nav aria-label='Studio screens' className='flex flex-1 items-center gap-6'>
          {STUDIO_SCREENS.map((screen) => {
            const active = isOnScreen(pathname, screen.href)
            return (
              <NextLink
                key={screen.href}
                href={screen.href}
                variant='nav'
                active={active}
                aria-current={active ? 'page' : undefined}
                className='text-sm'
              >
                {screen.label}
              </NextLink>
            )
          })}
        </nav>
        <ColorSchemeToggle />
      </div>
    </header>
  )
}
