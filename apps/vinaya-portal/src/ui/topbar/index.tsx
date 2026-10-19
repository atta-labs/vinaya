'use client'

import { Menu, X } from 'lucide-react'
import { usePathname } from 'next/navigation'
import type { ReactNode, RefObject } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '../components/button'
import { ChromeFrame } from '../components/chrome-frame'
import {
  closeNavigationMenus,
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuLink,
  NavigationMenuTrigger,
  useAnyNavigationMenuOpen
} from '../components/navigation-menu'
import { Sheet, SheetClose, SheetContent, SheetTrigger } from '../components/sheet'
import { ColorSchemeToggle } from '../lib/color-scheme-toggle'
import { NextLink } from '../lib/next-link'
import { cn } from '../lib/utils'
import { Logo } from '../libraries/shared/components/display/logo'

export interface TopBarLink {
  /**
   * A plain string renders as `{label}` inside the `NextLink`. Passing a
   * `ReactNode` instead renders that node in the same slot — e.g. a decorated
   * label with its own animation.
   */
  label: ReactNode
  href: string
  /** Match exact path for active state. Defaults to prefix match. */
  exact?: boolean
  external?: boolean
  /** Rendered before the label, both in the desktop row and the mobile sheet row. */
  icon?: ReactNode
}

export interface TopBarGroupItem extends TopBarLink {
  /** Muted one-line description shown under the label inside a group's dropdown panel. */
  description?: ReactNode
  /** In a `cards` section, the card spans the whole row. */
  wide?: boolean
  /** In a `preview` section, what the right-hand panel shows while this item is pointed at or focused. */
  preview?: { title: ReactNode; line: ReactNode; art?: ReactNode }
}

/** A titled block of a sectioned group's panel: its items render as a grid of tiles. */
export interface TopBarGroupSection {
  title: ReactNode
  /** Muted line beside the title. */
  description?: ReactNode
  /**
   * `tiles` (default): small icon tiles, four to a row. `cards`: large cards with drawn icons, two to a row.
   * `preview`: a list on the left and, on the right, the pointed-at item's `preview`.
   */
  layout?: 'tiles' | 'cards' | 'preview'
  items: TopBarGroupItem[]
}

export interface TopBarLinkGroup {
  label: ReactNode
  icon?: ReactNode
  /** Items shown in the dropdown panel (desktop) / nested rows (mobile sheet). */
  items: TopBarGroupItem[]
  /**
   * When set, the desktop panel is a wide, centred grid: one titled block per
   * section, its items as icon tiles, four to a row. `items` must still list
   * every item (active state and keys read it); the mobile sheet shows the
   * section titles as headers.
   */
  sections?: TopBarGroupSection[]
}

/** A group is discriminated by carrying `items` — flat links never do. */
export type TopBarNavItem = TopBarLink | TopBarLinkGroup

function isTopBarGroup(item: TopBarNavItem): item is TopBarLinkGroup {
  return 'items' in item
}

/** Stable React key for a nav item — groups have no `href` to key on. */
function navItemKey(item: TopBarNavItem): string {
  return isTopBarGroup(item) ? (item.items[0]?.href ?? String(item.label)) : item.href
}

/** A flat link row's content — icon + label when an icon is present, bare label otherwise (no empty wrapper). */
function linkRowContent(icon: ReactNode, label: ReactNode) {
  if (!icon) return label
  return (
    <span className='flex items-center gap-1.5'>
      <span className='size-4'>{icon}</span>
      {label}
    </span>
  )
}

export interface TopBarProps {
  /** Pre-built logo node rendered as-is (no link wrapper added). Takes precedence over logoText/logoUrl. */
  logo?: ReactNode
  /**
   * Extra className merged onto the `topbar`-variant `ChromeFrame`, after its own default
   * classes — a consumer can override e.g. the background opacity for its own effect
   * without touching the shared component. Unset by every existing caller, so this is a
   * no-op everywhere it isn't explicitly passed.
   */
  chromeClassName?: string
  logoText?: string
  logoHref?: string
  logoUrl?: string | null
  /** Two-line tagline rendered next to the logo. First element is the top line, second is the bottom. */
  logoTagline?: [string, string]
  /** Links shown to all users. */
  links?: TopBarNavItem[]
  /** Links shown only to signed-in users. Ignored when withAuth={false}. */
  signedInLinks?: TopBarNavItem[]
  /**
   * Extra actions rendered in the right section, next to `ColorSchemeToggle`.
   * When `withAuth`, shown only when signed in. When `withAuth={false}`,
   * always shown (there is no signed-in state to gate on).
   */
  extraActions?: ReactNode
  /** Actions rendered right after the logo, on the left. Desktop only, like `extraActions`. */
  leadingActions?: ReactNode
  /** Where the desktop `ColorSchemeToggle` sits in the right section: before the extra actions (default) or after them, at the very right. */
  colorSchemeToggle?: 'start' | 'end'
  /** Where the desktop links sit: centred in the bar (default) or on the left, right after the logo. */
  navAlign?: 'center' | 'start'
  /**
   * Positions the desktop links absolutely with the caller's own classes instead
   * (e.g. to line them up with a page's content column). A group's dropdown panel
   * then opens from the links' left edge.
   */
  navClassName?: string
  /** Extra classes for a sectioned group's panel, e.g. to cap its width to the room beside `navClassName`. */
  navPanelClassName?: string
  /**
   * Replaces the default bare <UserButton /> when signed in.
   * Ignored when withAuth={false}.
   */
  accountMenu?: ReactNode
  /**
   * Server-provided signed-in state. Avoids the client-side flash from useUser().
   * Ignored when withAuth={false}.
   */
  isSignedIn?: boolean
  /**
   * When false, skips all Clerk hooks and renders a static nav with no auth UI.
   * Default: true.
   */
  withAuth?: boolean
}

/** Dispatches to TopBarWithAuth or TopBarNoAuth based on withAuth prop. */
export function TopBar({ withAuth = true, ...rest }: TopBarProps) {
  return <TopBarNoAuth {...rest} />
}

// ─── Shared helpers ────────────────────────────────────────────────────────────

type InnerProps = Omit<TopBarProps, 'withAuth'>

function buildDefaultLogo(logoUrl: string | null | undefined, logoText: string, logoTagline?: [string, string]) {
  if (logoUrl) {
    return logoTagline ? (
      <Logo dark={logoUrl} alt={logoText} size='h-10' text={logoTagline} />
    ) : (
      <div className='flex items-center gap-2'>
        <Logo dark={logoUrl} alt={logoText} size='h-6' />
        {logoText && <span className='font-sans text-lg tracking-tight'>{logoText}</span>}
      </div>
    )
  }
  return <span className='font-sans text-lg tracking-tight'>{logoText}</span>
}

/**
 * While a top-bar menu is open, the page under the bar is softly blurred (its colours unchanged), so the open panel reads on its own. The
 * layer starts at the bar's measured bottom (the bar and the panel, portalled above it, stay sharp), fades over
 * 180ms (none under reduced motion), and a click on it closes the menu. It never takes the pointer while closed.
 */
function MenuBackdrop({ bar }: { bar: RefObject<HTMLElement | null> }) {
  const open = useAnyNavigationMenuOpen()
  const [top, setTop] = useState(0)
  useEffect(() => {
    if (!open) return
    const measure = () => setTop(Math.max(0, bar.current?.getBoundingClientRect().bottom ?? 0))
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [open, bar])
  return (
    <div
      aria-hidden='true'
      onClick={closeNavigationMenus}
      style={{ top }}
      className={cn(
        'fixed inset-x-0 bottom-0 z-40 backdrop-blur-[3px] transition-opacity duration-[180ms] ease-out motion-reduce:transition-none',
        open ? 'opacity-100' : 'pointer-events-none opacity-0'
      )}
    />
  )
}

/**
 * The mobile hamburger sheet's `lg:hidden` trigger button only hides the
 * BUTTON below `lg` — it says nothing about an ALREADY-OPEN sheet. The
 * sheet's open state is plain React state, not CSS, so opening the
 * sheet at a narrow width and then widening the browser back past `lg` would
 * leave it stuck open, full-screen, on top of the desktop nav. Holding the
 * sheet in controlled state and watching `(min-width: 1024px)` closes it the instant the
 * viewport crosses back into desktop range, matching `lg`'s own breakpoint
 * value (Tailwind's default, unchanged here) so the two can never disagree.
 */
function useAutoCloseMobileSheet() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const mql = window.matchMedia('(min-width: 1024px)')
    const closeIfDesktop = (e: MediaQueryList | MediaQueryListEvent) => {
      if (e.matches) setOpen(false)
    }
    closeIfDesktop(mql)
    mql.addEventListener('change', closeIfDesktop)
    return () => mql.removeEventListener('change', closeIfDesktop)
  }, [])
  return [open, setOpen] as const
}

/**
 * Trigger styled to sit alongside a plain `NextLink variant='nav'`: same size and
 * colour, no button chrome. Group labels bring their own chevron;
 * `[&:hover_.lucide-chevron-down]:rotate-180` flips it on hover, before the panel opens.
 */
function groupTriggerClassName(active: boolean) {
  return cn(
    'h-auto shrink-0 gap-1.5 whitespace-nowrap rounded-none bg-transparent px-0 py-0 text-sm font-normal leading-none text-muted-foreground',
    'hover:bg-transparent hover:text-primary focus:bg-transparent data-[state=open]:bg-transparent data-[state=open]:text-primary',
    '[&:hover_.lucide-chevron-down]:rotate-180 data-[state=open]:[&_.lucide-chevron-down]:rotate-180',
    active && 'text-primary font-medium'
  )
}

const PANEL_LINK =
  'outline-none transition-colors hover:bg-accent hover:text-accent-foreground data-[active]:bg-accent data-[active-item]:bg-accent'

function itemLinkProps(groupItem: TopBarGroupItem) {
  return (
    <NextLink
      variant='unstyled'
      href={groupItem.href}
      {...(groupItem.external ? { target: '_blank', rel: 'noreferrer' } : {})}
    />
  )
}

/** One titled block of a sectioned panel, in its layout. */
function SectionPanel({
  section,
  isActive
}: {
  section: TopBarGroupSection
  isActive: (href: string, exact?: boolean) => boolean
}) {
  // The preview opens on the page you are on, when it is one of these, else on the first item.
  const [pointed, setPointed] = useState(() =>
    Math.max(
      0,
      section.items.findIndex((groupItem) => isActive(groupItem.href, groupItem.exact))
    )
  )
  const heading = (
    <p className='flex items-baseline gap-2 px-1 text-sm'>
      <span className='font-medium text-foreground'>{section.title}</span>
      {section.description && <span className='text-xs text-muted-foreground'>{section.description}</span>}
    </p>
  )

  if (section.layout === 'preview') {
    const shown = section.items[pointed] ?? section.items[0]
    return (
      <div className='flex flex-col gap-2 py-3 first:pt-1 last:pb-1'>
        {heading}
        <div className='grid grid-cols-[minmax(0,19rem)_minmax(0,1fr)] gap-3'>
          <ul className='flex flex-col gap-1'>
            {section.items.map((groupItem, index) => (
              <li key={groupItem.href}>
                <NavigationMenuLink
                  active={isActive(groupItem.href, groupItem.exact)}
                  render={itemLinkProps(groupItem)}
                  onMouseEnter={() => setPointed(index)}
                  // Opening focuses the first item; follow focus only when it comes from the keyboard.
                  onFocus={(event) => {
                    if (event.currentTarget.matches(':focus-visible')) setPointed(index)
                  }}
                  className={cn(
                    'flex items-center gap-3.5 rounded-lg p-2.5 text-foreground',
                    PANEL_LINK,
                    index === pointed && 'bg-accent'
                  )}
                >
                  {groupItem.icon}
                  <span className='flex min-w-0 flex-col gap-0.5'>
                    <span className='text-base font-medium leading-tight'>{groupItem.label}</span>
                    {groupItem.description && (
                      <span className='truncate text-sm text-muted-foreground'>{groupItem.description}</span>
                    )}
                  </span>
                </NavigationMenuLink>
              </li>
            ))}
          </ul>
          {shown && (
            <NextLink
              variant='unstyled'
              href={shown.href}
              tabIndex={-1}
              aria-hidden='true'
              className='flex flex-col justify-between gap-6 rounded-xl border border-border bg-card p-6 text-foreground transition-colors hover:border-foreground/30'
            >
              <span className='flex flex-col gap-2.5'>
                <span className='font-mono text-xs uppercase tracking-widest text-ring'>{shown.label}</span>
                <span className='text-2xl leading-tight tracking-tight'>{shown.preview?.title ?? shown.label}</span>
                {(shown.preview?.line ?? shown.description) && (
                  <span className='text-sm leading-normal text-muted-foreground'>
                    {shown.preview?.line ?? shown.description}
                  </span>
                )}
              </span>
              <span className='flex items-end justify-between gap-4'>
                <span className='text-sm font-medium'>Open {shown.label} →</span>
                {shown.preview?.art}
              </span>
            </NextLink>
          )}
        </div>
      </div>
    )
  }

  const cards = section.layout === 'cards'
  return (
    <div className='flex flex-col gap-2 py-3 first:pt-1 last:pb-1'>
      {heading}
      <ul className={cn('grid gap-2', cards ? 'grid-cols-2 gap-3' : 'grid-cols-4')}>
        {section.items.map((groupItem) => (
          <li key={groupItem.href} className={cn(groupItem.wide && 'col-span-full')}>
            <NavigationMenuLink
              active={isActive(groupItem.href, groupItem.exact)}
              render={itemLinkProps(groupItem)}
              className={cn(
                'flex h-full rounded-md border border-border text-sm text-foreground hover:border-foreground/30 data-[active]:border-foreground/30 data-[active-item]:border-foreground/30',
                PANEL_LINK,
                cards ? 'items-center gap-4 rounded-xl p-4.5' : 'items-start gap-2.5 p-2.5'
              )}
            >
              {groupItem.icon &&
                (cards ? (
                  groupItem.icon
                ) : (
                  <span className='mt-0.5 size-4 shrink-0 text-muted-foreground'>{groupItem.icon}</span>
                ))}
              <span className={cn('flex min-w-0 flex-col', cards ? 'gap-1' : 'gap-0.5')}>
                <span className={cn('font-medium', cards && 'whitespace-nowrap text-lg leading-tight tracking-tight')}>
                  {groupItem.label}
                </span>
                {groupItem.description && (
                  <span className={cn('text-muted-foreground', cards ? 'truncate text-sm' : 'text-xs')}>
                    {groupItem.description}
                  </span>
                )}
              </span>
            </NavigationMenuLink>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * A dropdown's anchor, stretched down to the bar's bottom edge: with no gutter, the panel opens flush under the bar
 * instead of a few pixels under the link text.
 */
function toBarBottom(el: Element | null | undefined) {
  if (!el) return null
  const rect = el.getBoundingClientRect()
  const bottom = el.closest('nav')?.getBoundingClientRect().bottom ?? rect.bottom
  return { x: rect.x, y: rect.y, width: rect.width, height: Math.max(rect.height, bottom - rect.y) }
}

/** A group's desktop dropdown, sitting inline among the flat NextLinks. */
function DesktopNavGroup({
  item,
  isActive,
  rowRef,
  align = 'center',
  panelClassName
}: {
  item: TopBarLinkGroup
  isActive: (href: string, exact?: boolean) => boolean
  /** The desktop link row: a sectioned panel opens under it rather than under its own trigger. */
  rowRef: RefObject<HTMLDivElement | null>
  align?: 'center' | 'start'
  panelClassName?: string
}) {
  const groupActive = item.items.some((groupItem) => isActive(groupItem.href, groupItem.exact))
  const trigger = (
    <NavigationMenuTrigger className={groupTriggerClassName(groupActive)}>
      {item.icon && <span className='size-4'>{item.icon}</span>}
      {item.label}
    </NavigationMenuTrigger>
  )

  if (item.sections) {
    // The wide panel sits in the middle of the link row (centred links), or opens
    // from the row's left edge (left-aligned links), instead of hanging off its trigger.
    return (
      <NavigationMenu>
        {trigger}
        <NavigationMenuContent
          placement={align === 'center' ? 'bottom' : 'bottom-start'}
          gutter={0}
          getAnchorRect={() => toBarBottom(rowRef.current)}
        >
          <div
            className={cn(
              'flex flex-col divide-y divide-border p-3',
              // Cards and the preview list are narrower panels than the tile grid.
              item.sections.some((section) => section.layout === 'cards')
                ? 'w-[min(44rem,calc(100vw-2rem))]'
                : item.sections.some((section) => section.layout === 'preview')
                  ? 'w-[min(46rem,calc(100vw-2rem))]'
                  : 'w-[min(52rem,calc(100vw-2rem))]',
              panelClassName
            )}
          >
            {item.sections.map((section) => (
              <SectionPanel
                key={section.items[0]?.href ?? String(section.title)}
                section={section}
                isActive={isActive}
              />
            ))}
          </div>
        </NavigationMenuContent>
      </NavigationMenu>
    )
  }

  return (
    <NavigationMenu>
      {trigger}
      <NavigationMenuContent placement='bottom-start' gutter={0} getAnchorRect={(anchor) => toBarBottom(anchor)}>
        <ul className='grid w-64 gap-1 p-2'>
          {item.items.map((groupItem) => (
            <li key={groupItem.href}>
              <NavigationMenuLink
                active={isActive(groupItem.href, groupItem.exact)}
                render={
                  <NextLink
                    variant='unstyled'
                    href={groupItem.href}
                    {...(groupItem.external ? { target: '_blank', rel: 'noreferrer' } : {})}
                  />
                }
                className='flex items-start gap-2 rounded-sm p-2 text-sm text-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground data-[active-item]:bg-accent data-[active-item]:text-accent-foreground'
              >
                {groupItem.icon && (
                  <span className='mt-0.5 size-4 shrink-0 text-muted-foreground'>{groupItem.icon}</span>
                )}
                <span className='flex flex-col gap-0.5'>
                  <span>{groupItem.label}</span>
                  {groupItem.description && (
                    <span className='text-xs text-muted-foreground'>{groupItem.description}</span>
                  )}
                </span>
              </NavigationMenuLink>
            </li>
          ))}
        </ul>
      </NavigationMenuContent>
    </NavigationMenu>
  )
}

/** A group's mobile sheet rows — a non-navigating header row, then its items indented below. No dropdown inside the sheet. */
function SheetNavGroup({
  item,
  isActive
}: {
  item: TopBarLinkGroup
  isActive: (href: string, exact?: boolean) => boolean
}) {
  return (
    <>
      <div className='flex h-12 shrink-0 items-center gap-1.5 border-b border-border/30 text-sm text-muted-foreground'>
        {item.icon && <span className='size-4'>{item.icon}</span>}
        {item.label}
      </div>
      {(item.sections ?? [{ title: null, items: item.items }]).flatMap((section) => [
        section.title ? (
          <div
            key={`${String(section.items[0]?.href)}-title`}
            className='flex h-10 shrink-0 items-center border-b border-border/30 pl-4 text-xs text-muted-foreground'
          >
            {section.title}
          </div>
        ) : null,
        ...section.items.map((groupItem) => (
          <SheetClose
            key={groupItem.href}
            render={
              <NextLink
                variant='nav'
                active={isActive(groupItem.href, groupItem.exact)}
                href={groupItem.href}
                {...(groupItem.external ? { target: '_blank', rel: 'noreferrer' } : {})}
                className='flex h-12 shrink-0 items-center gap-1.5 border-b border-border/30 pl-4 text-sm'
              />
            }
          >
            {groupItem.icon && <span className='size-5 shrink-0 [&>svg]:size-5'>{groupItem.icon}</span>}
            {groupItem.label}
          </SheetClose>
        ))
      ])}
    </>
  )
}

// ─── Without Clerk auth ────────────────────────────────────────────────────────

function TopBarNoAuth({
  logo,
  logoText = '',
  logoHref = '/',
  logoUrl,
  logoTagline,
  chromeClassName,
  links = [],
  extraActions,
  leadingActions,
  colorSchemeToggle = 'start',
  navAlign = 'center',
  navClassName,
  navPanelClassName
}: InnerProps) {
  const pathname = usePathname()
  const [mobileMenuOpen, setMobileMenuOpen] = useAutoCloseMobileSheet()
  const rowRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLElement>(null)

  const isActive = (href: string, exact = false) => (exact ? pathname === href : pathname.startsWith(href))

  const defaultLogo = buildDefaultLogo(logoUrl, logoText, logoTagline)

  // Desktop nav links: absolutely centred in the bar, or (`navAlign='start'`) in the
  // left group after the logo, where `relative` anchors a group's dropdown panel.
  const desktopLinks = (
    <div
      ref={rowRef}
      className={cn(
        'hidden items-center gap-7 lg:flex',
        navClassName
          ? cn('absolute', navClassName)
          : navAlign === 'center'
            ? 'absolute left-1/2 -translate-x-1/2'
            : 'relative'
      )}
    >
      {links.map((item) => {
        if (isTopBarGroup(item)) {
          return (
            <DesktopNavGroup
              key={navItemKey(item)}
              item={item}
              isActive={isActive}
              rowRef={rowRef}
              align={navClassName ? 'start' : navAlign}
              panelClassName={navPanelClassName}
            />
          )
        }
        const { href, label, exact, external, icon } = item
        return (
          <NextLink
            key={navItemKey(item)}
            variant='nav'
            active={isActive(href, exact)}
            href={href}
            className='whitespace-nowrap text-sm'
            {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}
          >
            {linkRowContent(icon, label)}
          </NextLink>
        )
      })}
    </div>
  )

  return (
    <nav ref={barRef} className='w-full'>
      <MenuBackdrop bar={barRef} />
      <ChromeFrame variant='topbar' className={chromeClassName}>
        {/* Logo — pinned left, then any leading actions */}
        {/* With leading actions the left side sizes to its content and the right side takes the rest. */}
        <div className={cn('flex items-center gap-6', leadingActions ? 'shrink-0' : 'flex-1')}>
          {logo ? (
            logo
          ) : (
            <NextLink variant='unstyled' href={logoHref} className='flex shrink-0 items-center gap-2'>
              {defaultLogo}
            </NextLink>
          )}
          {leadingActions && <div className='hidden items-center gap-3 lg:flex'>{leadingActions}</div>}
          {!navClassName && navAlign === 'start' && desktopLinks}
        </div>

        {(navClassName || navAlign === 'center') && desktopLinks}

        {/* Desktop actions — pinned right (no auth UI) */}
        <div className='hidden flex-1 items-center justify-end gap-3 lg:flex'>
          {colorSchemeToggle === 'start' && <ColorSchemeToggle />}
          {extraActions}
          {colorSchemeToggle === 'end' && <ColorSchemeToggle />}
        </div>

        {/* Mobile actions */}
        <div className='ml-auto flex items-center gap-2 lg:hidden'>
          <ColorSchemeToggle />
          {links.length > 0 && (
            <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
              <SheetTrigger render={<Button variant='outline' size='icon' aria-label='Open menu' />}>
                <Menu className='h-4 w-4' />
                <span className='sr-only'>Open menu</span>
              </SheetTrigger>
              <SheetContent
                side='top'
                showCloseButton={false}
                className='flex flex-col gap-0 p-0 data-[side=top]:h-dvh'
              >
                <div className='flex h-14 shrink-0 items-center justify-between px-6'>
                  {logo ? (
                    logo
                  ) : (
                    <SheetClose
                      render={<NextLink variant='unstyled' href={logoHref} className='flex items-center gap-2' />}
                    >
                      {defaultLogo}
                    </SheetClose>
                  )}
                  <div className='flex items-center gap-2'>
                    <ColorSchemeToggle />
                    <SheetClose render={<Button variant='outline' size='icon' aria-label='Close menu' />}>
                      <X className='h-4 w-4' />
                      <span className='sr-only'>Close menu</span>
                    </SheetClose>
                  </div>
                </div>
                <nav className='flex min-h-0 flex-1 flex-col overflow-y-auto px-6'>
                  {/* Top-aligned, same as `TopBarWithAuth`'s sheet — never `justify-center` on
                      the scroll container, which clips the first row above `scrollTop: 0`. */}
                  <div className='pt-4 [&>*:last-child]:border-b-0'>
                    {links.map((item) => {
                      if (isTopBarGroup(item)) {
                        return <SheetNavGroup key={navItemKey(item)} item={item} isActive={isActive} />
                      }
                      const { href, label, exact, external, icon } = item
                      return (
                        <SheetClose
                          key={navItemKey(item)}
                          render={
                            <NextLink
                              variant='nav'
                              active={isActive(href, exact)}
                              href={href}
                              {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}
                              className='flex h-12 shrink-0 items-center border-b border-border/30 text-sm'
                            />
                          }
                        >
                          {linkRowContent(icon, label)}
                        </SheetClose>
                      )
                    })}
                    {extraActions && (
                      <div className='flex h-12 shrink-0 items-center border-b border-border/30'>{extraActions}</div>
                    )}
                  </div>
                </nav>
              </SheetContent>
            </Sheet>
          )}
        </div>
      </ChromeFrame>
    </nav>
  )
}
