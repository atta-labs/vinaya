import { COMMANDS, CONFIG_REFERENCE } from '@attalabs/vinaya-sources'
import type { ReactNode } from 'react'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  Code
} from '@/ui/components'
import { NextLink } from '@/ui/lib/next-link'
import { Heading, Text } from '@/ui/shared'
import { DOCS_NAV, type DocsGroup, sectionId, topKey } from '../_lib/portal-docs'
import { CommandBlock } from '../(standalone)/cli/_components/CommandBlock'
import { commandSlug } from '../(standalone)/cli/_components/command-slug'
import { DetailText } from '../(standalone)/cli/_components/DetailText'
import { ConfigFieldSection } from '../(standalone)/config/_components/ConfigFieldSection'
import { CopyPageButton } from './CopyPageButton'

/** A docs page's head: where it sits (half, then page), its title with the copy control, one line. */
export function DocHead({
  half,
  title,
  line,
  parent
}: {
  half: DocsGroup['id']
  title: string
  line: string
  parent?: { title: string; href: string }
}) {
  const group = DOCS_NAV.find((g) => g.id === half)
  return (
    <header className='flex flex-col gap-4 pb-8'>
      <Breadcrumb>
        <BreadcrumbList className='font-sans text-sm'>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <NextLink variant='unstyled' href={group?.href ?? '/docs'}>
                {group?.title}
              </NextLink>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          {parent && (
            <>
              <BreadcrumbItem>
                <BreadcrumbLink asChild>
                  <NextLink variant='unstyled' href={parent.href}>
                    {parent.title}
                  </NextLink>
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
            </>
          )}
          <BreadcrumbItem>
            <BreadcrumbPage>{title}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <div className='flex items-start justify-between gap-4'>
        <Heading level={1} weight='normal' variant='page' family='sans' tone='foreground'>
          {title}
        </Heading>
        <CopyPageButton />
      </div>
      <Text variant='lead' tone='muted'>
        {line}
      </Text>
    </header>
  )
}

/** A section of prose: a heading (anchored, listed under "On this page") and its paragraphs or lists. */
export function DocSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className='flex flex-col gap-4 py-6'>
      <Heading
        level={2}
        weight='normal'
        id={sectionId(title)}
        size='2xl'
        family='sans'
        tone='foreground'
        className='scroll-mt-8'
      >
        {title}
      </Heading>
      <div className='flex flex-col gap-4 font-sans text-base leading-7 text-foreground/90'>{children}</div>
    </section>
  )
}

/** Plain paragraph text, in the docs' body style. */
export function P({ children }: { children: ReactNode }) {
  return <p>{children}</p>
}

/** A link to another page, in the docs' body style. */
export function DocLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <NextLink href={href} className='underline underline-offset-4'>
      {children}
    </NextLink>
  )
}

/** The named CLI commands, as the CLI reference renders them: synopsis, what it does, its options. */
export function CommandList({ names }: { names: string[] }) {
  const commands = names.map((n) => COMMANDS.find((c) => c.name === n)).filter((c) => c !== undefined)
  return (
    <div className='flex flex-col gap-8'>
      {commands.map((command) => (
        <div key={command.name} id={commandSlug(command.name)} className='flex scroll-mt-6 flex-col gap-3'>
          <Heading level={3} weight='normal' size='lg' family='mono'>
            {command.name}
          </Heading>
          <CommandBlock
            command={
              command.name === 'init' || command.name === 'quickstart'
                ? `npx @attalabs/vinaya ${command.name}`
                : `vinaya ${command.name}`
            }
          />
          <Text family='sans'>{command.description}</Text>
          {command.details?.map((paragraph) => (
            <DetailText key={paragraph} text={paragraph} />
          ))}
          {command.flags && command.flags.length > 0 && (
            <div className='flex flex-col gap-1 pl-4'>
              {command.flags.map((flag) => (
                <div key={flag.flag} className='flex flex-wrap items-baseline gap-2'>
                  <Code>{flag.flag}</Code>
                  <Text as='span' size='sm' family='sans' tone='muted'>
                    {flag.description}
                  </Text>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

/** The config keys of one half, top-level keys in the given order, each with its nested keys under it. */
export function ConfigKeys({ keys }: { keys: string[] }) {
  return (
    <div className='flex flex-col gap-10'>
      {keys.flatMap((k) =>
        CONFIG_REFERENCE.filter((f) => topKey(f.key) === k).map((field) => (
          <ConfigFieldSection key={field.key} field={field} />
        ))
      )}
    </div>
  )
}
