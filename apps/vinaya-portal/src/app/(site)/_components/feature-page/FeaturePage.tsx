import type { ReactNode } from 'react'
import { NextLink } from '@/ui/lib/next-link'
import { cn } from '@/ui/lib/utils'
import { Heading, Text } from '@/ui/shared'
import { WRAP } from '../../vinaya-process/_components/process-styles'
import { NamedIcon } from '../icons'
import { ButtonLink } from '../landing/ButtonLink'

// One feature's page: what it is, its real view from home, what it shows, what it never does, how to use it, and
// the features on either side. The five feature pages differ only in their data.

interface FeatureNeighbour {
  n: number
  name: string
  href: string
}

interface FeaturePageProps {
  n: number
  /** The feature's name; its drawn icon is the one the icon registry holds for that name. */
  name: string
  lead: string
  tags: readonly string[]
  docsHref: string
  command?: string
  liveLabel: string
  live: ReactNode
  shows: {
    eyebrow: string
    title: string
    items: readonly { title: string; line: string; href: string; icon: (className: string) => ReactNode }[]
  }
  never: { eyebrow: string; title: ReactNode; lead: string; items: readonly [string, string][] }
  use: { title: string; line: string; code: readonly string[] }
  prev?: FeatureNeighbour
  next?: FeatureNeighbour
}

const CARD_LINK = 'rounded-xl border border-border/60 transition-colors hover:border-foreground/40'

export function FeaturePage(props: FeaturePageProps) {
  const { n, name, lead, tags, docsHref, command, liveLabel, live, shows, never, use, prev, next } = props
  return (
    <main className='bg-background text-foreground'>
      <section className={cn(WRAP, 'flex flex-col items-start gap-7 pt-12 pb-12 sm:pt-16 sm:pb-16')}>
        <Text as='span' variant='eyebrow' tone='muted'>
          Feature 0{n} / 05
        </Text>
        <div className='flex flex-wrap items-center gap-5 sm:gap-7'>
          <NamedIcon name={name} className='size-16 sm:size-22' />
          <h1 className='font-sans text-6xl leading-none tracking-tighter sm:text-8xl'>{name}</h1>
        </div>
        <p className='max-w-3xl text-xl leading-snug text-muted-foreground sm:text-2xl'>{lead}</p>
        <ul className='flex flex-wrap gap-2.5'>
          {tags.map((tag) => (
            <li
              key={tag}
              className='rounded-full border border-border/60 px-3 py-1.5 font-mono text-sm text-muted-foreground'
            >
              {tag}
            </li>
          ))}
        </ul>
        <div className='mt-2 flex flex-wrap items-center gap-3.5'>
          <ButtonLink href={docsHref} size='xl'>
            Read the {name} docs
          </ButtonLink>
          {command && (
            <code className='rounded-md border border-border/60 px-5 py-3 font-mono text-base'>
              <span className='text-muted-foreground'>$ </span>
              {command}
            </code>
          )}
        </div>
      </section>

      <section aria-label={liveLabel} className={WRAP}>
        {live}
      </section>

      <section className={cn(WRAP, 'flex flex-col gap-10 pt-24 sm:pt-30')}>
        <div className='flex flex-col gap-3.5'>
          <Text as='span' variant='eyebrow' tone='muted'>
            {shows.eyebrow}
          </Text>
          <Heading level={2} weight='normal' variant='headline'>
            {shows.title}
          </Heading>
        </div>
        <ul className={cn('grid gap-4 md:grid-cols-2', shows.items.length === 4 ? 'lg:grid-cols-4' : 'lg:grid-cols-3')}>
          {shows.items.map((item) => (
            <li key={item.title}>
              <NextLink
                href={item.href}
                variant='unstyled'
                className={cn(CARD_LINK, 'flex h-full flex-col gap-6 bg-card p-7')}
              >
                {item.icon('size-14')}
                <span className='flex flex-col gap-2'>
                  <span className='text-2xl leading-tight tracking-tight'>{item.title}</span>
                  <span className='text-lg leading-normal text-muted-foreground'>{item.line}</span>
                </span>
              </NextLink>
            </li>
          ))}
        </ul>
      </section>

      <section className={cn(WRAP, 'grid items-start gap-12 pt-24 sm:pt-30 lg:grid-cols-2')}>
        <div className='flex flex-col gap-3.5'>
          <Text as='span' variant='eyebrow' tone='muted'>
            {never.eyebrow}
          </Text>
          <Heading level={2} weight='normal' variant='headline'>
            {never.title}
          </Heading>
          <Text variant='lead' tone='muted' className='mt-1.5'>
            {never.lead}
          </Text>
        </div>
        <ol className='flex flex-col border-t border-border/60'>
          {never.items.map(([title, line], i) => (
            <li key={title} className='grid grid-cols-[3rem_minmax(0,1fr)] gap-3 border-b border-border/60 py-5.5'>
              <span className='font-mono text-sm leading-relaxed text-ring'>0{i + 1}</span>
              <span className='text-lg leading-normal'>
                {title} <span className='text-muted-foreground'>{line}</span>
              </span>
            </li>
          ))}
        </ol>
      </section>

      <section className={cn(WRAP, 'pt-24 sm:pt-30')}>
        <div className='flex flex-wrap items-center justify-between gap-8 rounded-2xl border border-border/60 bg-card p-8 sm:p-12'>
          <div className='flex flex-col gap-2.5'>
            <h2 className='font-sans text-3xl leading-tight tracking-tighter sm:text-4xl'>{use.title}</h2>
            <p className='text-lg text-muted-foreground'>{use.line}</p>
          </div>
          <pre className='max-w-full overflow-x-auto rounded-lg border border-border/60 bg-background px-6 py-5 font-mono text-base leading-loose'>
            {use.code.map((line, i) => (
              <span key={line} className={cn('block', i > 0 && 'text-muted-foreground')}>
                {line.startsWith('$ ') ? (
                  <>
                    <span className='text-muted-foreground'>$ </span>
                    {line.slice(2)}
                  </>
                ) : (
                  line
                )}
              </span>
            ))}
          </pre>
        </div>
      </section>

      <nav aria-label='Other features' className={cn(WRAP, 'grid gap-4 pt-24 pb-30 sm:grid-cols-2')}>
        {prev ? (
          <NextLink href={prev.href} variant='unstyled' className={cn(CARD_LINK, 'flex flex-col gap-1.5 p-6.5')}>
            <span className='font-mono text-sm text-muted-foreground'>← 0{prev.n} / 05</span>
            <span className='text-2xl tracking-tight'>{prev.name}</span>
          </NextLink>
        ) : (
          <span />
        )}
        {next && (
          <NextLink
            href={next.href}
            variant='unstyled'
            className={cn(CARD_LINK, 'flex flex-col items-end gap-1.5 p-6.5 text-right')}
          >
            <span className='font-mono text-sm text-muted-foreground'>0{next.n} / 05 →</span>
            <span className='text-2xl tracking-tight'>{next.name}</span>
          </NextLink>
        )}
      </nav>
    </main>
  )
}
