'use client'

import * as Ariakit from '@ariakit/react'
import { AnimatePresence, MotionConfig, motion, type Variants } from 'motion/react'
import * as React from 'react'
import { cn } from '../lib/utils'

// A site-navigation dropdown on Ariakit's menu: hovering or clicking the
// trigger opens a panel of links, arrow keys move between them, Escape closes
// it and returns focus. Ariakit has no NavigationMenu; this covers what the top
// bar uses (one trigger, one panel of links per group).
//
// Animation follows Ariakit's "Menu with Motion" recipe: the store's `mounted`
// state drives `AnimatePresence`, the menu stays `alwaysVisible` so Motion owns
// the exit, and variants spring the panel open and stagger its links in.

const panel = {
  closed: { opacity: 0, scale: 0.96, transition: { duration: 0.12, ease: 'easeIn' } },
  open: {
    opacity: 1,
    scale: 1,
    transition: { type: 'spring', duration: 0.35, bounce: 0.15, delayChildren: 0.04, staggerChildren: 0.025 }
  }
} satisfies Variants

const link = {
  closed: { opacity: 0, y: -4 },
  open: { opacity: 1, y: 0, transition: { duration: 0.2, ease: 'easeOut' } }
} satisfies Variants

// Every open top-bar menu, so opening one closes the others: hovering from one trigger to the next never leaves
// two panels open.
const openMenus = new Set<Ariakit.MenuStore>()

// Who wants to know whether any of them is open (the top bar dims and blurs the page while one is).
const openListeners = new Set<() => void>()
const notifyOpen = () => {
  for (const listener of openListeners) listener()
}

/** True while any top-bar menu is open. */
function useAnyNavigationMenuOpen() {
  return React.useSyncExternalStore(
    (listener) => {
      openListeners.add(listener)
      return () => {
        openListeners.delete(listener)
      }
    },
    () => openMenus.size > 0,
    () => false
  )
}

/** Closes every open top-bar menu (a click on the blurred page). */
function closeNavigationMenus() {
  for (const store of openMenus) store.hide()
}

// The pointer leaving both the trigger and the panel closes the menu after a short grace, however it was opened
// (Ariakit's own rule only covers a menu opened by hover). Re-entering either within the grace keeps it open.
const LEAVE_GRACE_MS = 220

const HoverIntent = React.createContext<{ enter: () => void; leave: (event: React.PointerEvent) => void } | null>(null)

function useHoverIntentProps() {
  const intent = React.useContext(HoverIntent)
  return {
    onPointerEnter: () => intent?.enter(),
    onPointerLeave: (event: React.PointerEvent) => intent?.leave(event)
  }
}

function NavigationMenu({ children }: { children?: React.ReactNode }) {
  const store = Ariakit.useMenuStore({ placement: 'bottom' })
  const open = Ariakit.useStoreState(store, 'open')
  React.useEffect(() => {
    if (!open) return
    for (const other of openMenus) other.hide()
    openMenus.add(store)
    notifyOpen()
    return () => {
      openMenus.delete(store)
      notifyOpen()
    }
  }, [open, store])
  const timer = React.useRef<number | undefined>(undefined)
  const intent = React.useMemo(
    () => ({
      enter: () => window.clearTimeout(timer.current),
      leave: (event: React.PointerEvent) => {
        if (event.pointerType !== 'mouse') return
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => store.hide(), LEAVE_GRACE_MS)
      }
    }),
    [store]
  )
  React.useEffect(() => () => window.clearTimeout(timer.current), [])
  return (
    <MotionConfig reducedMotion='user'>
      <HoverIntent.Provider value={intent}>
        <Ariakit.MenuProvider store={store}>{children}</Ariakit.MenuProvider>
      </HoverIntent.Provider>
    </MotionConfig>
  )
}

/** Opens on hover and on click. `data-state="open|closed"` is kept for styling. */
function NavigationMenuTrigger({ className, ...props }: Omit<Ariakit.MenuButtonProps, 'store'>) {
  const store = Ariakit.useMenuContext()
  const open = Ariakit.useStoreState(store, 'open')
  const hover = useHoverIntentProps()
  return (
    <Ariakit.MenuButton
      {...hover}
      data-slot='navigation-menu-trigger'
      data-state={open ? 'open' : 'closed'}
      showOnHover
      className={cn(
        'group inline-flex w-max cursor-pointer items-center justify-center text-sm font-medium outline-none transition-colors',
        'focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50',
        className
      )}
      {...props}
    />
  )
}

type NavigationMenuContentProps = Omit<Ariakit.MenuProps, 'store' | 'render'> & {
  /** Where the panel opens relative to its anchor (the trigger, unless `getAnchorRect` says otherwise). */
  placement?: Ariakit.MenuStoreState['placement']
}

function NavigationMenuContent({ className, placement, ...props }: NavigationMenuContentProps) {
  const store = Ariakit.useMenuContext()
  // Placement lives on the store; the panel sets it, as the caller passes it here.
  React.useLayoutEffect(() => {
    if (placement) store?.setState('placement', placement)
  }, [store, placement])
  const mounted = Ariakit.useStoreState(store, 'mounted')
  const open = Ariakit.useStoreState(store, 'open')
  const hover = useHoverIntentProps()
  return (
    <AnimatePresence>
      {mounted && (
        <Ariakit.Menu
          {...hover}
          data-slot='navigation-menu-content'
          portal
          alwaysVisible
          gutter={6}
          className={cn(
            'z-50 overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-lg outline-none',
            'origin-(--popover-transform-origin)',
            className
          )}
          render={<motion.div variants={panel} initial='closed' animate={open ? 'open' : 'closed'} exit='closed' />}
          {...props}
        />
      )}
    </AnimatePresence>
  )
}

type NavigationMenuLinkProps = Omit<Ariakit.MenuItemProps, 'store'> & {
  /** The current page: sets `data-active` and `aria-current`. */
  active?: boolean
}

// Motion processes its own props first, then hands the rest to Ariakit's
// MenuItem, as in Ariakit's recipe; the link inherits the panel's variants.
const MotionMenuItem = motion.create(Ariakit.MenuItem)

/** A link in the panel. Pass the link element through `render` (`render={<NextLink href=… />}`). */
function NavigationMenuLink({ active, ...props }: NavigationMenuLinkProps) {
  return (
    <MotionMenuItem
      data-slot='navigation-menu-link'
      data-active={active ? '' : undefined}
      aria-current={active ? 'page' : undefined}
      variants={link}
      {...(props as React.ComponentProps<typeof MotionMenuItem>)}
    />
  )
}

export {
  closeNavigationMenus,
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuLink,
  NavigationMenuTrigger,
  useAnyNavigationMenuOpen
}
