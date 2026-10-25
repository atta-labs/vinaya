'use client'

import { ArrowRight } from 'lucide-react'
import { usePathname } from 'next/navigation'
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem
} from '@/ui/components'
import { NextLink } from '@/ui/lib/next-link'
import { cn } from '@/ui/lib/utils'
import { iconForName, SMALL_ICON } from '../../_components/icons'
import { DOCS_NAV, type DocsPage, groupForPath } from '../_lib/portal-docs'

/** One sidebar entry; a page's children show while you are in that section. */
function PageItem({ page, pathname }: { page: DocsPage; pathname: string }) {
  const isActive = pathname === page.href
  const inSection = isActive || (page.children ?? []).some((c) => c.href === pathname)
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        size='sm'
        isActive={isActive}
        render={<NextLink variant='unstyled' href={page.href} />}
        className={cn(
          'h-auto min-h-8 rounded-md px-2.5 py-1.5 font-sans text-sm font-normal',
          isActive
            ? 'bg-primary/10 font-medium text-primary data-[active]:bg-primary/10 data-[active]:text-primary'
            : 'text-sidebar-foreground/65 hover:text-sidebar-foreground'
        )}
      >
        {/* Only the section headings carry icons; a page link never does, so what can be clicked reads apart from
            what cannot. Every title lines up with its section's title, past the heading's icon. */}
        <span className='flex items-center gap-2.5'>
          <span className='w-5 shrink-0' aria-hidden />
          {page.title}
        </span>
      </SidebarMenuButton>
      {inSection && page.children && (
        <SidebarMenu className='mt-0.5 ml-10 gap-0.5 border-l border-sidebar-border pl-2'>
          {page.children.map((child) => {
            const childActive = pathname === child.href
            return (
              <SidebarMenuItem key={child.href}>
                <SidebarMenuButton
                  size='sm'
                  isActive={childActive}
                  render={<NextLink variant='unstyled' href={child.href} />}
                  className={cn(
                    'h-auto min-h-7 rounded-md px-2.5 py-1 font-sans text-xs font-normal',
                    childActive
                      ? 'bg-primary/10 font-medium text-primary data-[active]:bg-primary/10 data-[active]:text-primary'
                      : 'text-sidebar-foreground/60 hover:text-sidebar-foreground'
                  )}
                >
                  {child.title}
                </SidebarMenuButton>
              </SidebarMenuItem>
            )
          })}
        </SidebarMenu>
      )}
    </SidebarMenuItem>
  )
}

/** Each docs set's badge at the top of its sidebar: the icon its title names, and what it is. */
const HEAD_LINE: Record<string, string> = {
  start: 'Docs · works with any process',
  process: 'Docs · the default process'
}

/**
 * One docs set at a time: The Vinaya harness and The Vinaya process each have
 * their own sidebar. The other sets are links at the foot, never tabs.
 */
export function PortalDocsSidebar() {
  const pathname = usePathname() ?? ''
  const active = groupForPath(pathname)
  const others = DOCS_NAV.filter((g) => g.id !== active?.id)
  return (
    <SidebarContent role='navigation' aria-label='Docs' className='gap-0 overflow-y-auto px-2 py-4'>
      {active && (
        <NextLink
          variant='unstyled'
          href={active.href}
          className='mx-2 mb-3 flex items-center gap-3 rounded-lg border border-sidebar-border bg-sidebar-accent/40 p-2.5 transition-colors hover:bg-sidebar-accent'
        >
          <span className='flex size-9 shrink-0 items-center justify-center rounded-md border border-sidebar-border bg-background text-sidebar-foreground'>
            {(() => {
              const Icon = iconForName(active.title)
              return Icon ? <Icon className={SMALL_ICON} still /> : null
            })()}
          </span>
          <span className='flex min-w-0 flex-col'>
            <span className='font-sans text-sm font-medium tracking-tight text-sidebar-foreground'>{active.title}</span>
            <span className='truncate font-sans text-xs text-sidebar-foreground/60'>{HEAD_LINE[active.id]}</span>
          </span>
        </NextLink>
      )}
      {active?.sections.map((section) => (
        <SidebarGroup key={section.title} className='py-3'>
          <SidebarGroupLabel className='h-auto gap-2.5 px-2.5 pb-2 font-sans text-sm font-medium text-sidebar-foreground [&>svg]:size-5'>
            {/* Every section uses the same custom family as its subject page. */}
            {(() => {
              const Icon = iconForName(section.title)
              return Icon ? <Icon className={SMALL_ICON} still /> : null
            })()}
            {section.title}
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className='gap-1'>
              {section.pages.map((page) => (
                <PageItem key={page.href} page={page} pathname={pathname} />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ))}
      <div className='mx-2 mt-4 flex flex-col gap-1 border-t border-sidebar-border pt-4'>
        <span className='px-1 pb-1 font-sans text-xs text-sidebar-foreground/60'>Other docs</span>
        {others.map((g) => (
          <NextLink
            key={g.id}
            variant='unstyled'
            href={g.href}
            className='flex items-center justify-between gap-1 rounded-md px-1 py-1.5 font-sans text-sm text-sidebar-foreground/75 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground'
          >
            {g.title}
            <ArrowRight className='size-3.5' aria-hidden />
          </NextLink>
        ))}
      </div>
    </SidebarContent>
  )
}
