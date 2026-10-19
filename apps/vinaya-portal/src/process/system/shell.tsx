'use client'

import {
  Box,
  Boxes,
  Component,
  GitBranch,
  LayoutList,
  type LucideIcon,
  MessageSquareCode,
  MonitorCog,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  Route,
  Workflow
} from 'lucide-react'
import { usePathname } from 'next/navigation'
import { type ReactNode, useEffect, useState } from 'react'
import { Button, Separator } from '@/ui/components'
import { NextLink } from '@/ui/lib/next-link'
import { cn } from '@/ui/lib/utils'
import { Heading, Text } from '@/ui/shared'

/** The design system's sections, one page each. Order is the reading order. */
const sections = [
  { slug: '', label: 'Tokens', icon: Palette, blurb: 'The theme the CMS renders, and the stage palette on top of it.' },
  {
    slug: 'environment',
    label: 'Environment',
    icon: MonitorCog,
    blurb: 'The two setup steps (environment, then flow) and the top-bar menus that change them later.'
  },
  {
    slug: 'chat',
    label: 'Chat & terminal',
    icon: MessageSquareCode,
    blurb: 'One window, six chromes; the typed line in each.'
  },
  {
    slug: 'cards',
    label: 'Cards & chips',
    icon: Component,
    blurb: 'Choice, output, task chips, gate pills, the Log rail, banner, stats, proposals.'
  },
  { slug: 'steps', label: 'Steps', icon: LayoutList, blurb: 'The step header and its play controls.' },
  {
    slug: 'diagram-elements',
    label: 'Diagram elements',
    icon: Boxes,
    blurb: 'The card in every state, the band, the mocks, each stage alone.'
  },
  {
    slug: 'diagram',
    label: 'Process diagram',
    icon: Workflow,
    blurb:
      'The whole diagram, driven by a moment: a flow, a stage, and how the gates stand. Covered = the flow never passes here. Muted = later. Lit = now. Observability is always on; every stage writes to it.'
  },
  { slug: 'scene', label: '3D scene', icon: Box, blurb: 'The canvas, one state object in.' },
  { slug: 'studio', label: 'Studio', icon: Route, blurb: 'Mission Control rows for a moment.' },
  {
    slug: 'flows',
    label: 'Flow diagrams',
    icon: GitBranch,
    blurb:
      'Five still diagrams: each flow drawing only its own part, then the whole process. All are the same stage layers, so a change to a layer (the dev-review loop, the gates, the Log) shows in every diagram that draws it.'
  }
] as const

const KEY = 'vinaya.system.sidebar'

export function SystemShell({ children }: { children: ReactNode }) {
  const path = usePathname()
  const [open, setOpen] = useState(true)
  useEffect(() => {
    try {
      if (localStorage.getItem(KEY) === 'closed') setOpen(false)
    } catch {}
  }, [])
  const toggle = () => {
    const next = !open
    setOpen(next)
    try {
      localStorage.setItem(KEY, next ? 'open' : 'closed')
    } catch {}
  }
  return (
    <div
      className={cn(
        'grid min-h-dvh grid-cols-1 transition-[grid-template-columns] duration-200 ease-out',
        open ? 'md:grid-cols-[240px_minmax(0,1fr)]' : 'md:grid-cols-[56px_minmax(0,1fr)]'
      )}
    >
      <aside className='overflow-hidden border-b border-sidebar-border bg-sidebar px-3 py-4 text-sidebar-foreground md:sticky md:top-0 md:h-dvh md:border-b-0 md:border-r'>
        <div className='flex h-8 items-center gap-2'>
          <Button
            variant='ghost'
            size='icon'
            onClick={toggle}
            aria-label={open ? 'Hide the sidebar' : 'Show the sidebar'}
          >
            {open ? <PanelLeftClose /> : <PanelLeftOpen />}
          </Button>
          <NextLink
            href='/'
            variant='unstyled'
            className={cn(
              'block min-w-0 transition-opacity duration-150',
              open ? 'opacity-100' : 'pointer-events-none opacity-0'
            )}
          >
            <Text as='span' size='xs' variant='eyebrow' tone='muted' className='whitespace-nowrap'>
              Vinaya · system
            </Text>
          </NextLink>
        </div>
        <Separator className='my-4 bg-sidebar-border' />
        <nav className='grid gap-0.5'>
          {sections.map((s) => {
            const href = s.slug ? `/system/${s.slug}` : '/system'
            const active = path === href || (s.slug === '' && path === '/system/')
            const Icon = s.icon as LucideIcon
            return (
              <NextLink
                key={s.slug}
                href={href}
                variant='unstyled'
                title={open ? undefined : s.label}
                aria-label={s.label}
                className={cn(
                  'flex h-8 items-center gap-2.5 rounded-md px-2 text-sm transition-colors',
                  active
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                    : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground'
                )}
              >
                <Icon className='size-4 shrink-0' aria-hidden />
                <span className={cn('truncate transition-opacity duration-150', open ? 'opacity-100' : 'opacity-0')}>
                  {s.label}
                </span>
              </NextLink>
            )
          })}
        </nav>
      </aside>
      <main className='min-w-0 px-5 py-10 md:px-10'>{children}</main>
    </div>
  )
}

/** Page header for a section. */
export function SectionHeader({ slug }: { slug: (typeof sections)[number]['slug'] }) {
  const s = sections.find((x) => x.slug === slug) ?? sections[0]
  return (
    <header className='mb-10 grid gap-2'>
      <Text as='span' size='xs' variant='eyebrow' tone='muted'>
        /system{s.slug ? `/${s.slug}` : ''}
      </Text>
      <Heading level={1} size='3xl'>
        {s.label}
      </Heading>
      <Text tone='muted' className='max-w-[60ch]'>
        {s.blurb}
      </Text>
    </header>
  )
}

/** A labelled group of examples. */
export function Group({ name, children }: { name: string; children: ReactNode }) {
  return (
    <section className='mb-12 grid gap-4'>
      <Text as='span' size='xs' variant='eyebrow' tone='muted'>
        {name}
      </Text>
      {children}
    </section>
  )
}

/** One example row: a label on the left, the thing on the right. */
export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className='grid grid-cols-1 items-baseline gap-2 md:grid-cols-[140px_minmax(0,1fr)] md:gap-4'>
      <Text as='span' size='xs' family='mono' tone='muted'>
        {label}
      </Text>
      <div className='grid min-w-0 gap-2'>{children}</div>
    </div>
  )
}
