import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CircleAlert, Info, Lightbulb } from 'lucide-react'
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { DOCS_STATUS } from '@/content/docs-status'
import type { FlowKey } from '@/process/types'
import {
  Badge,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  Code,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/ui/components'
import { NextLink } from '@/ui/lib/next-link'
import { cn } from '@/ui/lib/utils'
import { Heading, Text } from '@/ui/shared'
import { iconForHref } from '../../_components/icons'
import { type DocsPage, HARNESS_KEYS, PROCESS_KEYS, sectionId } from '../_lib/portal-docs'
import { CopyPageButton } from './CopyPageButton'
import { DocAccordion, DocCode, DocTabs } from './DocBlocks'
import { FlowDiagram, WholeDiagramButton } from './FlowDiagrams'
import { CommandList, ConfigKeys } from './PortalDoc'
import { StickyDocHeader } from './StickyDocHeader'

const CONTENT_DIR = join(process.cwd(), 'src', 'content', 'docs-tree')

/** The plain text of a node's children, for anchor ids and copy text. */
const textOf = (node: ReactNode): string =>
  typeof node === 'string' || typeof node === 'number'
    ? String(node)
    : Array.isArray(node)
      ? node.map(textOf).join('')
      : node && typeof node === 'object' && 'props' in node
        ? textOf((node.props as { children?: ReactNode }).children)
        : ''

/** Splits a block body on `=== Label` lines into labelled parts. */
const splitOn = (body: string, marker: RegExp) => {
  const parts: { label: string; body: string }[] = []
  for (const line of body.split('\n')) {
    const m = line.match(marker)
    const last = parts.at(-1)
    if (m) parts.push({ label: m[1]?.trim() ?? '', body: '' })
    else if (last) last.body += `${line}\n`
  }
  return parts
}

const CALLOUT = {
  note: { icon: Info, label: 'Note', frame: 'border-border bg-muted/40' },
  tip: { icon: Lightbulb, label: 'Tip', frame: 'border-primary/30 bg-primary/5' },
  warning: { icon: CircleAlert, label: 'Warning', frame: 'border-destructive/40 bg-destructive/5' }
} as const

/** One fenced block of the docs' own kinds, or a plain code block. */
function Block({ lang, body }: { lang: string; body: string }) {
  const [kind, variant] = lang.split('-')
  if (kind === 'callout') {
    const c = CALLOUT[(variant as keyof typeof CALLOUT) ?? 'note'] ?? CALLOUT.note
    const Icon = c.icon
    return (
      <aside className={`flex gap-3 rounded-lg border px-4 py-3 ${c.frame}`}>
        <Icon className='mt-1 size-4 shrink-0 text-muted-foreground' aria-label={c.label} />
        <div className='flex min-w-0 flex-col gap-3 text-sm'>
          <Md>{body}</Md>
        </div>
      </aside>
    )
  }
  // The process diagram as a picture: ```flow-diagram with a flow key (feature, medium, backlog, hot) as its body,
  // and ```whole-diagram for the button that opens every flow at once.
  if (lang === 'flow-diagram') return <FlowDiagram flow={body.trim() as FlowKey} />
  if (lang === 'whole-diagram') return <WholeDiagramButton />
  if (kind === 'steps') {
    const steps = splitOn(body, /^###\s+(.*)$/)
    // Each step: a number badge and, below it, a rule that runs down to the next
    // badge (none after the last), beside the step's title and text.
    return (
      <ol className='my-2 flex flex-col'>
        {steps.map((s, i) => (
          <li key={s.label} className='grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-4'>
            <div className='flex flex-col items-center'>
              <span className='flex size-7 shrink-0 items-center justify-center rounded-full bg-muted font-sans text-xs font-medium text-foreground'>
                {i + 1}
              </span>
              {i < steps.length - 1 && <span className='my-1.5 w-px flex-1 bg-border' aria-hidden />}
            </div>
            <div className={cn('flex min-w-0 flex-col gap-2', i < steps.length - 1 && 'pb-7')}>
              <p className='flex min-h-7 items-center font-medium text-foreground'>{s.label}</p>
              <Md>{s.body}</Md>
            </div>
          </li>
        ))}
      </ol>
    )
  }
  if (kind === 'tabs') {
    return <DocTabs panels={splitOn(body, /^===\s+(.*)$/).map((p) => ({ label: p.label, body: <Md>{p.body}</Md> }))} />
  }
  if (kind === 'accordion') {
    return (
      <DocAccordion items={splitOn(body, /^###\s+(.*)$/).map((p) => ({ title: p.label, body: <Md>{p.body}</Md> }))} />
    )
  }
  if (kind === 'cards') {
    const cards = body
      .split('\n')
      .map((l) => l.match(/^-\s*\[([^\]]+)\]\(([^)]+)\)\s*(.*)$/))
      .filter((m): m is RegExpMatchArray => m !== null)
    // Icons only when every card in the block has one, so a block never mixes cards with and without.
    const withIcons = cards.every(([, , href]) => iconForHref(href ?? ''))
    return (
      <div className='my-2 grid gap-3 sm:grid-cols-2'>
        {cards.map(([, title, href, line]) => (
          <NextLink key={href} variant='unstyled' href={href ?? '#'} className='block'>
            <Card variant='link' className='h-full'>
              <CardHeader className='flex-row items-start gap-3.5 p-4'>
                {(() => {
                  const Icon = withIcons ? iconForHref(href ?? '') : undefined
                  return Icon ? <Icon className='size-9' /> : null
                })()}
                <span className='flex min-w-0 flex-col gap-1'>
                  <CardTitle size='md' weight='medium' family='sans'>
                    {title}
                  </CardTitle>
                  {line && <CardDescription>{line}</CardDescription>}
                </span>
              </CardHeader>
            </Card>
          </NextLink>
        ))}
      </div>
    )
  }
  // Generated reference, read from the CLI and config sources: one name per line.
  const names = body
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  if (kind === 'commands') return <CommandList names={names} />
  if (lang === 'config-keys') {
    const keys = names.flatMap((n) => (n === 'harness' ? HARNESS_KEYS : n === 'process' ? PROCESS_KEYS : [n]))
    return <ConfigKeys keys={keys} />
  }
  // A plain code block: ```lang or ```lang:file-name
  const [, title] = lang.split(':')
  return (
    <DocCode code={body.replace(/\n$/, '')} title={title}>
      <code>{body.replace(/\n$/, '')}</code>
    </DocCode>
  )
}

/**
 * Lets a long code name wrap only where it reads naturally: after a `.`, `_`, `/`
 * or `-` (`meta.input_versions.manifest_version`), never mid-word. `<wbr>` adds a
 * break chance without changing the copied text.
 */
const breakable = (node: ReactNode): ReactNode =>
  typeof node === 'string' && node.length > 16
    ? node.split(/(?<=[._/-])/).reduce<{ out: ReactNode[]; at: number }>(
        ({ out, at }, part) => ({
          out: at === 0 ? [part] : [...out, <wbr key={`wbr-${at}`} />, part],
          at: at + part.length
        }),
        { out: [], at: 0 }
      ).out
    : node

const components: Components = {
  h2: ({ children }) => (
    <Heading
      level={2}
      weight='normal'
      id={sectionId(textOf(children))}
      size='2xl'
      family='sans'
      tone='foreground'
      className='scroll-mt-16 pt-8'
    >
      {children}
    </Heading>
  ),
  h3: ({ children }) => (
    <Heading
      level={3}
      weight='normal'
      id={sectionId(textOf(children))}
      family='sans'
      size='lg'
      tone='foreground'
      className='scroll-mt-16 pt-4'
    >
      {children}
    </Heading>
  ),
  h4: ({ children }) => <p className='pt-2 font-sans font-medium text-foreground'>{children}</p>,
  ul: ({ children }) => <ul className='flex list-disc flex-col gap-1.5 pl-5'>{children}</ul>,
  ol: ({ children }) => <ol className='flex list-decimal flex-col gap-1.5 pl-5'>{children}</ol>,
  a: ({ href, children }) => (
    <NextLink href={href ?? '#'} className='underline underline-offset-4'>
      {children}
    </NextLink>
  ),
  code: ({ className, children }) =>
    className ? (
      <code className={className}>{children}</code>
    ) : (
      <Code className='mx-0.5 text-[0.85em]'>{breakable(children)}</Code>
    ),
  pre: ({ children }) => {
    const code = Children.toArray(children).find(isValidElement) as ReactElement<{
      className?: string
      children?: ReactNode
    }>
    const lang = code?.props.className?.replace(/^language-/, '') ?? ''
    return <Block lang={lang} body={textOf(code?.props.children)} />
  },
  // The `@/ui` Table, as the Vinaya portal's docs use it: responsive (a wide
  // table scrolls in its own box) and its header pins while the table scrolls past.
  // `[&_thead_th]:top-12` pins it under the page's reading bar (`StickyDocHeader`, `h-12`).
  table: ({ children }) => (
    <Table stickyHeader variant='docs' containerClassName='my-2 @min-[780px]/tbl:[&_thead_th]:top-12'>
      {children}
    </Table>
  ),
  thead: ({ children }) => <TableHeader>{children}</TableHeader>,
  tbody: ({ children }) => <TableBody>{children}</TableBody>,
  tr: ({ children }) => <TableRow>{children}</TableRow>,
  th: ({ children }) => <TableHead className='whitespace-nowrap'>{children}</TableHead>,
  td: ({ children }) => <TableCell className='whitespace-normal'>{children}</TableCell>,
  blockquote: ({ children }) => (
    <blockquote className='border-l-2 border-border pl-4 text-muted-foreground'>{children}</blockquote>
  )
}

/** Markdown in the docs' body style, with the docs' own block kinds. */
function Md({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {children}
    </ReactMarkdown>
  )
}

/** The header lines of a tree file: `Summary:`, `Parent:`, `Badges:`. */
const headerValue = (lines: string[], key: string) => lines.find((l) => l.startsWith(`${key}: `))?.slice(key.length + 2)

/**
 * A docs page rendered from one file of the documentation tree: the section it
 * sits in above the title, the summary and badges under it, then the body.
 */
export async function MarkdownDoc({ page, eyebrow }: { page: DocsPage & { source: string }; eyebrow: string }) {
  const raw = await readFile(join(CONTENT_DIR, page.source), 'utf8')
  const lines = raw.split('\n')
  const summary = headerValue(lines, 'Summary') ?? page.line
  const badges = (headerValue(lines, 'Badges') ?? '')
    .split('·')
    .map((b) => b.trim())
    .filter(Boolean)
  const status = DOCS_STATUS[page.href]
  const bodyStart = lines.findIndex((l, i) => i > 0 && l.startsWith('## '))
  const body = lines.slice(bodyStart >= 0 ? bodyStart : 1).join('\n')

  return (
    <>
      <StickyDocHeader title={page.title} />
      <header className='flex flex-col gap-4 pb-6'>
        <Text family='sans' size='sm' tone='muted'>
          {eyebrow}
        </Text>
        <div className='flex items-start justify-between gap-4'>
          <Heading level={1} weight='normal' variant='page' family='sans' tone='foreground'>
            {page.title}
          </Heading>
          <CopyPageButton />
        </div>
        <Text variant='lead' tone='muted'>
          {summary}
        </Text>
        {(status || badges.length > 0) && (
          <div className='flex flex-wrap gap-2'>
            {status && <Badge variant='secondary'>{status}</Badge>}
            {badges.map((b) => (
              <Badge key={b} variant='label'>
                {b}
              </Badge>
            ))}
          </div>
        )}
      </header>
      <div className='doc-page-content flex flex-col gap-4 font-sans text-base leading-7 text-foreground/90'>
        <Md>{body}</Md>
        {page.children && page.children.length > 0 && !body.includes('```cards') && (
          <Md>
            {`## In this section\n\n\`\`\`cards\n${page.children.map((c) => `- [${c.title}](${c.href}) ${c.line}`).join('\n')}\n\`\`\`\n`}
          </Md>
        )}
      </div>
    </>
  )
}
