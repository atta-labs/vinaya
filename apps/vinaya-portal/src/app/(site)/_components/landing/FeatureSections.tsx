'use client'

import { ArrowDown, ArrowUpRight, FileText, Plug, SquareTerminal } from 'lucide-react'
import { type ReactNode, useRef } from 'react'
import { improveFindings, improveProposals, improveStats, timeSplit } from '@/process/fixtures/lifecycle'
import { clamp01 } from '@/ui/lib/math'
import { NextLink } from '@/ui/lib/next-link'
import { cn } from '@/ui/lib/utils'
import { Heading, Text } from '@/ui/shared'
import { ELEMENT_ICONS } from '../icons'
import { useEnterProgress, useNarrow, usePinProgress, useReducedMotion, useSeen } from './LandingInteractions'
import { LandingSection } from './LandingSection'
import { LOOP_EVENT_COUNT, type LoopScript } from './LoopMonitor'
import { STUDIO_STEPS, type StudioMilestone, StudioMock, type StudioTask } from './StudioSection'
import { Terminal, type TerminalLine } from './Terminal'

const ConfigurationIcon = ELEMENT_ICONS['configuration']
const DevProcessIcon = ELEMENT_ICONS['dev-process']
const LogIcon = ELEMENT_ICONS['log']
const SelfImprovementIcon = ELEMENT_ICONS['self-improvement']
const StudioIcon = ELEMENT_ICONS['studio']
const TelemetryIcon = ELEMENT_ICONS['telemetry']

// Home's five features, one full-width section each. The motion is the portal's own: scroll drives it (Studio pins like
// StudioSection, the Log types as it comes up the screen). Under reduced motion every section shows its end state.

// The board's frame for a feature section: the 1312px column, a 16-64px gutter, 96px of air on a phone and
// up to 168px on a wide screen.
const FRAME =
  'flex min-h-[calc(100svh-3.5rem)] max-w-[82rem] flex-col justify-center px-4 py-24 sm:px-[clamp(1rem,4.5vw,4rem)] min-[900px]:py-[clamp(6rem,11.7vw,10.5rem)]'

const FADE = 'transition-[opacity,transform] duration-[400ms] motion-reduce:transition-none'
const shown = (on: boolean) => (on ? 'translate-y-0 opacity-100' : 'translate-y-3 opacity-0')

function FeatureLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <NextLink
      href={href}
      variant='unstyled'
      className={cn(
        'mt-2 inline-flex items-center gap-2 border-b-[1.5px] border-foreground py-2 text-lg font-medium hover:text-muted-foreground min-[900px]:text-lg',
        className
      )}
    >
      {children}
      <ArrowUpRight className='size-[18px]' strokeWidth={1.75} aria-hidden />
    </NextLink>
  )
}

// Each feature's drawn icon, beside its title.
const FEATURE_ICONS: Record<string, typeof LogIcon> = {
  Log: LogIcon,
  Telemetry: TelemetryIcon,
  Studio: StudioIcon,
  'Self-improvement': SelfImprovementIcon,
  Configuration: ConfigurationIcon
}
const TITLE_ICON = 'size-10 min-[900px]:size-[clamp(3rem,4.2vw,3.75rem)]'

/** A feature's words: its place in the five, its name, its line and the way to its page. */
function FeatureCopy({
  n,
  name,
  line,
  href,
  linkClassName,
  lineClassName,
  compact = false
}: {
  n: number
  name: string
  line: string
  /** Its docs page; without one (Telemetry has none yet) the feature shows no link. */
  href?: string
  linkClassName?: string
  lineClassName?: string
  /** A tighter stack, for a section that has to fit one phone screen. */
  compact?: boolean
}) {
  const Icon = FEATURE_ICONS[name]
  return (
    <div className={cn('flex min-w-0 flex-col items-start', compact ? 'gap-3 min-[900px]:gap-5' : 'gap-5')}>
      <Text as='span' variant='eyebrow' tone='muted'>{`0${n} / 05`}</Text>
      <span className='flex items-center gap-4 min-[900px]:gap-5'>
        {Icon && <Icon className={TITLE_ICON} />}
        <Heading level={3} weight='normal' variant='headline'>
          {name}
        </Heading>
      </span>
      <Text variant='lead' tone='muted' className={cn('max-w-[32.5rem]', lineClassName)}>
        {line}
      </Text>
      {href ? (
        <FeatureLink href={href} className={linkClassName}>
          Open {name}
        </FeatureLink>
      ) : null}
    </div>
  )
}

const INDEX = [
  ['log', 'Log', 'Written down as it happens', LogIcon],
  ['telemetry', 'Telemetry', 'What the Log adds up to', TelemetryIcon],
  ['studio', 'Studio', 'A live dashboard of every task and review', StudioIcon],
  ['self-improvement', 'Self-improve', 'The reports turn into changes you approve', SelfImprovementIcon],
  ['configuration', 'Configuration', 'One file turns the harness on', ConfigurationIcon]
] as const

/** The five, as an index under the heading: five columns on a wide screen, full-width rows on a phone. They fade in,
    one after another, once the index enters the screen; under reduced motion they are simply there. Each title sits
    beside its icon on one line. The icons are drawn in the titles' ink here: their accent is orange, which the site
    keeps for where a person decides. */
function FeatureIndex() {
  const ref = useRef<HTMLElement>(null)
  const seen = useSeen(ref, 0.85)
  return (
    <nav
      ref={ref}
      aria-label='The five features'
      className='flex flex-col border-t border-foreground min-[900px]:grid min-[900px]:grid-cols-5 min-[900px]:border-b min-[900px]:border-b-border/50'
    >
      {INDEX.map(([id, name, line, Icon], i) => (
        <NextLink
          key={id}
          href={`#${id}`}
          variant='unstyled'
          className={cn(
            'grid grid-cols-[2.5rem_minmax(0,1fr)_1.25rem] items-start gap-x-2 gap-y-1 border-b border-border/50 py-[18px] hover:text-muted-foreground min-[900px]:flex min-[900px]:flex-col min-[900px]:gap-3.5 min-[900px]:border-b-0 min-[900px]:pt-8 min-[900px]:pb-9',
            i === 0
              ? 'min-[900px]:pr-4 xl:pr-7'
              : 'min-[900px]:border-l min-[900px]:border-l-border/50 min-[900px]:px-4 xl:px-7',
            i === INDEX.length - 1 && 'min-[900px]:pr-0 xl:pr-0',
            'transition-[opacity,translate,transform] duration-700 ease-out motion-reduce:transition-none',
            seen ? 'translate-y-0 opacity-100' : 'translate-y-3 opacity-0'
          )}
          style={{ transitionDelay: seen ? `${i * 110}ms` : '0ms' }}
        >
          <span className='font-mono text-sm leading-relaxed tracking-wider text-muted-foreground min-[900px]:flex min-[900px]:items-center min-[900px]:justify-between min-[900px]:text-base min-[900px]:leading-normal'>
            0{i + 1}
            <ArrowDown className='hidden size-[18px] min-[900px]:block' strokeWidth={1.75} aria-hidden />
          </span>
          <span className='flex flex-col gap-1 min-[900px]:gap-3.5'>
            <span className='flex items-start gap-3 min-[900px]:gap-2.5 xl:gap-3'>
              <Icon className='size-8 min-[900px]:-mt-0.5 min-[900px]:size-7 xl:size-9' />
              <Text as='span' variant='title' className='min-w-0 min-[900px]:whitespace-nowrap [hyphens:none]'>
                {name}
              </Text>
            </span>
            <Text as='span' size='lg' leading='snug' tone='muted'>
              {line}
            </Text>
          </span>
          <ArrowDown className='mt-1 size-[18px] min-[900px]:hidden' strokeWidth={1.75} aria-hidden />
        </NextLink>
      ))}
    </nav>
  )
}

/** The heading over the five: the title, its line under it, then the index. */
function FeaturesIntro() {
  return (
    <div className='flex flex-col gap-10 min-[900px]:gap-[4.5rem]'>
      <div className='flex flex-col gap-[18px] min-[900px]:gap-7'>
        <Heading level={2} weight='normal' variant='display'>
          Five features,
          <br />
          one harness
        </Heading>
        <Text variant='intro' tone='muted' className='max-w-[40rem]'>
          What every team gets when it installs Vinaya
        </Text>
      </div>
      <FeatureIndex />
    </div>
  )
}

const CONFIG = `{
  "rings": {
    "ring1_forgeWriteInterception": true,
    "ring2_asyncAudits": true
  },
  "checks": {
    "acme/secret-scan": {
      "run": "./scripts/vinaya-checks/secret-scan.ts",
      "scope": "full"
    }
  },
  "logs": {
    "url": "https://logs.acme.dev/v1/events"
  }
}`

// The file's three blocks (rings, checks, logs) by line, so they can fill in one after another the way the
// portal's ConfigBoardSection fills its slots: the braces are always there, a block's lines spring in once the
// scroll reaches it.
const CONFIG_BLOCK = [-1, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 2, 2, 2, -1] as const
const LINE_DELAYS = [
  'delay-0',
  'delay-[70ms]',
  'delay-[140ms]',
  'delay-[210ms]',
  'delay-[280ms]',
  'delay-[350ms]'
] as const

// A line's key in muted ink, the rest as written; it springs in once its block is on.
function ConfigLine({ line, on, delay }: { line: string; on: boolean; delay: string }) {
  const match = /^(\s*)("[^"]+")(:.*)$/.exec(line)
  return (
    <span
      className={cn(
        'block transition-[opacity,transform] duration-[400ms] ease-out motion-reduce:transition-none',
        delay,
        on ? 'translate-y-0 opacity-100' : 'translate-y-[6px] opacity-0'
      )}
    >
      {match ? (
        <>
          {match[1]}
          <span className='text-muted-foreground'>{match[2]}</span>
          {match[3]}
        </>
      ) : (
        line || ' '
      )}
    </span>
  )
}

// The heading and the index that open the five.
function FeaturesIntroSection() {
  return (
    <LandingSection
      background='bg-secondary text-secondary-foreground'
      py='compact'
      className='max-w-[82rem] px-4 pt-24 pb-0 sm:px-[clamp(1rem,4.5vw,4rem)] min-[900px]:pt-[clamp(6rem,11.7vw,10.5rem)]'
    >
      <FeaturesIntro />
    </LandingSection>
  )
}

// 05 · Configuration, the last of the five, after Self-improvement.
function ConfigurationSection() {
  const fileRef = useRef<HTMLDivElement>(null)
  // As ConfigBoardSection: q = floor(progress * 5), one block per step as the file comes up the screen.
  const filled = Math.min(3, Math.floor(useEnterProgress(fileRef, 0.85, 0.5) * 5))
  return (
    <LandingSection
      id='configuration'
      background='bg-secondary text-secondary-foreground'
      py='compact'
      className={FRAME}
    >
      <div className='flex flex-col'>
        <div className='grid gap-10 min-[900px]:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] min-[900px]:items-center min-[900px]:gap-24'>
          <FeatureCopy
            n={5}
            name='Configuration'
            line='One file turns the harness on: process, agents, forge, log and gates.'
            href='/docs/features/configuration'
          />
          <div ref={fileRef} className='min-w-0'>
            <ConfigFile filled={filled} />
          </div>
        </div>
      </div>
    </LandingSection>
  )
}

// The merge scene's twelve events, in its order and at its times.
export const LOG_LINES: readonly TerminalLine[] = [
  { time: '11:02', mark: '›', text: 'milestone checkout-v2 opened' },
  { time: '11:03', mark: '›', text: 'issues #418–#422 labelled' },
  { time: '11:04', mark: '✓', text: 'issues synced to the milestone' },
  { time: '11:05', mark: '›', text: 'developer agent coding · feat/418' },
  { time: '11:06', mark: '✓', text: 'branch pushed' },
  { time: '11:07', mark: '›', text: 'PR #893 opened' },
  { time: '11:08', mark: '›', text: 'code review + security dispatched' },
  { time: '11:09', mark: '✓', text: 'review approved · security pass' },
  { time: '11:10', mark: '›', text: 'vinaya check running' },
  { time: '11:11', mark: '✓', text: 'vi passed · every rule green' },
  { time: '11:12', mark: '✓', text: 'PR #893 merged' },
  { time: '11:13', mark: '☞', text: 'checkout-v2 landed on main' }
]

// The report is the interactive Complex work flow's own (`/vinaya-process`): the checkout-v2 milestone, its four
// figures and where the time went, read from the same fixtures so Home and the walk tell one story.
const REPORT_FIGURES = improveStats.map((stat) => ({
  label: stat.label,
  value: stat.value,
  note: stat.detail
}))
const TIME_SPLIT = timeSplit

// 04 · Self-improvement, its own section after Studio: the feature's words, then the Improver's proposals, which fill
// in one after another as the list comes up the screen. The first is the one a person approved and sent back to
// product as a new Project. Scrolling back un-plays it.
function SelfImprovementSection() {
  const ref = useRef<HTMLDivElement>(null)
  const progress = useEnterProgress(ref, 0.9, 1)
  const on = (from: number) => progress >= from
  return (
    <LandingSection id='self-improvement' background='bg-background text-foreground' py='compact' className={FRAME}>
      <div ref={ref} className='flex flex-col gap-14 min-[900px]:gap-[4.5rem]'>
        <FeatureCopy
          n={4}
          name='Self-improvement'
          line='What the reports add up to: the Improver reads them and proposes changes to the process. A person approves, and each one goes back to product.'
          href='/docs/features/self-improvement'
          lineClassName='max-w-[40rem]'
        />
        <ImproverProposals on={on} />
      </div>
    </LandingSection>
  )
}

// 01 · Log and 02 · Telemetry, two features in one section joined by a line, driven by scroll the way the portal's
// sections are: the Log
// types its twelve lines as the terminal comes up the screen; then, as the reader carries on down, the line draws
// into the report and the report fills in (its bar, the four figures, the time split, the three check figures).
// Scrolling back un-plays it. Under reduced motion everything shows.
function LogTelemetrySection() {
  const logRef = useRef<HTMLDivElement>(null)
  const reportRef = useRef<HTMLDivElement>(null)
  const logProgress = useEnterProgress(logRef, 0.85, 0.7)
  const reportProgress = useEnterProgress(reportRef, 0.9, 1)
  const lines = Math.floor(logProgress * (LOG_LINES.length + 0.99))
  // The board's beats, in its milliseconds from the line (9 s) to the time bar (12.4 s), laid along the
  // report's scroll progress.
  const at = (t: number) => reportProgress >= 0.04 + ((t - 9000) / 3400) * 0.86

  return (
    <LandingSection id='log' background='bg-background text-foreground' py='compact' className={FRAME}>
      <div className='flex flex-col'>
        <div className='grid min-[900px]:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] min-[900px]:items-end min-[900px]:gap-24'>
          <FeatureCopy
            n={1}
            name='Log'
            line='Every check, review and decision written down as it happens, with who made it.'
            href='/docs/features/log'
            lineClassName='max-w-[40rem]'
            linkClassName='min-[900px]:hidden'
          />
          <FeatureLink href='/docs/features/log' className='mb-2 hidden justify-self-start min-[900px]:inline-flex'>
            Open Log
          </FeatureLink>
        </div>

        {/* Beat 1 · the Log */}
        <div
          ref={logRef}
          className='mt-[4.5rem] grid gap-y-7 min-[900px]:mt-28 min-[900px]:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] min-[900px]:grid-rows-[auto_1fr] min-[900px]:gap-x-24 min-[900px]:gap-y-12'
        >
          <div className='flex flex-col gap-3.5 min-[900px]:col-start-2 min-[900px]:row-start-1 min-[900px]:gap-6 min-[900px]:pt-2'>
            <Text as='span' variant='eyebrow' tone='muted'>
              The Log
            </Text>
            <Heading level={3} weight='normal' variant='title'>
              Written down as it happens
            </Heading>
            <Text as='span' variant='lead' tone='muted'>
              One merge, event by event
              <span className='hidden min-[900px]:inline'>
                , from the milestone opening to the code landing on main
              </span>
              . The <span className='text-ring'>☞</span> line is the call a person made.
            </Text>
          </div>
          <div className='min-w-0 min-[900px]:col-start-1 min-[900px]:row-span-2 min-[900px]:row-start-1'>
            <LogTerminal count={lines} />
          </div>
          <div className='-mt-3 flex gap-3.5 self-start border border-dashed border-border bg-card p-4 min-[900px]:col-start-2 min-[900px]:row-start-2 min-[900px]:mt-0 min-[900px]:gap-5 min-[900px]:p-6'>
            <span className='grid size-10 shrink-0 place-items-center border border-foreground min-[900px]:size-12'>
              <Plug className='size-5 min-[900px]:size-[22px]' strokeWidth={1.75} aria-hidden />
            </span>
            <div className='flex min-w-0 flex-col gap-1.5 min-[900px]:gap-2.5'>
              <span className='text-lg min-[900px]:text-xl'>Plug in your own log server</span>
              <pre className='whitespace-pre-wrap font-mono text-sm leading-normal text-muted-foreground [overflow-wrap:anywhere] min-[900px]:text-base min-[900px]:leading-relaxed'>
                {'"logs": {\n  "url": "https://logs.acme.dev/v1/events"\n}'}
              </pre>
            </div>
          </div>
        </div>

        {/* The connection: the Log feeds Telemetry, the second feature */}
        <div
          id='telemetry'
          ref={reportRef}
          className='grid min-h-60 grid-cols-[2.5rem_minmax(0,1fr)] gap-x-3 min-[900px]:min-h-[17.5rem] min-[900px]:grid-cols-[5rem_minmax(0,1fr)] min-[900px]:gap-x-0'
        >
          <div aria-hidden='true' className='flex flex-col items-center'>
            <span className='-mt-[2.5px] size-[5px] shrink-0 bg-muted-foreground' />
            <span className='relative w-px flex-1'>
              <span
                className='absolute inset-x-0 top-0 bg-muted-foreground'
                style={{ height: `${clamp01((reportProgress - 0.04) / 0.18) * 100}%` }}
              />
            </span>
            <svg
              viewBox='0 0 9 5'
              aria-hidden='true'
              className={cn(
                'h-[5px] w-[9px] shrink-0 fill-none stroke-muted-foreground transition-opacity duration-200 motion-reduce:transition-none',
                at(9900) ? 'opacity-100' : 'opacity-0'
              )}
            >
              <path d='M0.5 0.5 4.5 4.5 8.5 0.5' strokeWidth='1' />
            </svg>
          </div>
          <div
            className={cn(
              FADE,
              shown(at(9300)),
              'flex max-w-[47.5rem] flex-col gap-3 pt-14 pb-10 min-[900px]:gap-3.5 min-[900px]:pt-[4.5rem] min-[900px]:pb-14 min-[900px]:pl-2'
            )}
          >
            <FeatureCopy
              n={2}
              name='Telemetry'
              line='The same events, counted for a milestone: how long each ticket took, what the reviewers caught, how often the checks said no.'
              lineClassName='max-w-[40rem]'
            />
          </div>
        </div>

        {/* Beat 2 · Telemetry: the milestone report, compact (head, the four figures in one row, the time split) */}
        <MilestoneReport at={at} />
      </div>
    </LandingSection>
  )
}

/** The `vinaya.config.json` file, its blocks springing in as `filled` counts up (0–3). Home and /configuration. */
export function ConfigFile({ filled }: { filled: number }) {
  return (
    <div className='min-w-0 border border-border/50 bg-card'>
      <div className='flex items-center gap-2.5 border-b border-border/50 px-4 py-3 font-mono text-sm text-muted-foreground min-[900px]:px-7 min-[900px]:py-3.5 min-[900px]:text-base'>
        <FileText className='hidden size-4 shrink-0 min-[900px]:block' aria-hidden />
        vinaya.config.json
      </div>
      <pre className='overflow-x-auto whitespace-pre-wrap px-4 py-[18px] font-mono text-sm leading-relaxed text-foreground [overflow-wrap:anywhere] min-[900px]:whitespace-pre min-[900px]:px-9 min-[900px]:py-8 min-[900px]:text-lg min-[900px]:leading-relaxed min-[900px]:[overflow-wrap:normal]'>
        {CONFIG.split('\n').map((line, index) => {
          const block = CONFIG_BLOCK[index] ?? -1
          const first = CONFIG_BLOCK.indexOf(block as (typeof CONFIG_BLOCK)[number])
          return (
            <ConfigLine
              key={index}
              line={line}
              on={block < 0 || filled > block}
              delay={LINE_DELAYS[Math.min(LINE_DELAYS.length - 1, index - first)] ?? 'delay-0'}
            />
          )
        })}
      </pre>
    </div>
  )
}

/** The Improver's three proposals from Checkout v2, each fading in once `on` reaches it. Home and /self-improvement. */
export function ImproverProposals({ on }: { on: (from: number) => boolean }) {
  return (
    <div className='flex flex-col border border-border/50 bg-card'>
      <div className='flex flex-col gap-1 border-b border-border/50 px-4 py-3.5 min-[900px]:flex-row min-[900px]:items-baseline min-[900px]:justify-between min-[900px]:gap-6 min-[900px]:px-8 min-[900px]:py-6'>
        <Text as='span' variant='eyebrow' tone='muted'>
          The Improver · from Checkout v2
        </Text>
        <Text as='span' size='lg'>
          3 <span className='text-muted-foreground'>proposals · 1 approved, now a Project</span>
        </Text>
      </div>
      <ol>
        {improveProposals.map((proposal, i) => {
          const approved = i === 0
          return (
            <li
              key={proposal.title}
              className={cn(
                FADE,
                shown(on(0.4 + i * 0.12)),
                'grid gap-x-8 gap-y-1.5 border-b border-border/50 px-4 py-3.5 last:border-b-0 min-[900px]:grid-cols-[minmax(0,5fr)_minmax(0,5fr)_8rem] min-[900px]:items-baseline min-[900px]:px-8 min-[900px]:py-5'
              )}
            >
              <Text as='span' size='lg' leading='snug' tone='muted'>
                {improveFindings[i]?.found}
              </Text>
              <span className='flex flex-col gap-1'>
                <Text as='span' variant='title'>
                  {proposal.title}
                </Text>
                <Text as='span' size='lg' leading='snug' tone='muted'>
                  {proposal.kind} · {proposal.text}
                </Text>
              </span>
              <span
                className={cn(
                  'font-mono text-sm uppercase tracking-widest min-[900px]:justify-self-end',
                  approved ? 'text-ring' : 'text-muted-foreground'
                )}
              >
                {approved ? '☞ Approved' : 'Proposed'}
              </span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

/** The `vinaya log --follow` terminal showing the first `count` of the merge's twelve events. Home and /log. */
export function LogTerminal({ count }: { count: number }) {
  return (
    <Terminal
      header={
        <>
          <span className='inline-flex items-center gap-2.5'>
            <SquareTerminal className='hidden size-4 shrink-0 min-[900px]:block' aria-hidden />$ vinaya log --follow
          </span>
          <span className='inline-flex items-center gap-2'>
            <i className='inline-block size-[7px] rounded-full bg-success min-[900px]:size-2' />
            live
          </span>
        </>
      }
      headerClassName='whitespace-nowrap px-3.5 py-2.5 text-muted-foreground min-[900px]:px-6 min-[900px]:py-3.5 min-[900px]:text-base'
      lines={LOG_LINES.slice(0, count)}
      rows={12}
      anchor='top'
      highlightLast
      className='text-sm min-[900px]:text-lg'
      aria-hidden='true'
    />
  )
}

/** The Checkout v2 milestone report; `at(ms)` says whether its beat (bar, figures, time split) has played. Home and
 * /telemetry. */
export function MilestoneReport({ at }: { at: (ms: number) => boolean }) {
  return (
    <div className='flex flex-col border border-border/50 bg-card'>
      <div className='flex flex-col gap-2.5 border-b border-border/50 px-4 py-3.5 min-[900px]:gap-3 min-[900px]:px-8 min-[900px]:py-6'>
        <Text as='span' variant='eyebrow' tone='muted'>
          Milestone report
        </Text>
        <div className='flex flex-col gap-1 min-[900px]:flex-row min-[900px]:flex-wrap min-[900px]:items-baseline min-[900px]:justify-between min-[900px]:gap-6'>
          <Heading level={3} weight='normal' variant='title'>
            Checkout v2
          </Heading>
          <Text as='span' size='lg'>
            52 of 52 <span className='text-muted-foreground'>tasks merged</span>
          </Text>
        </div>
        <div className='h-1.5 bg-border/50'>
          <div
            className={cn(
              'h-full w-full origin-left bg-success transition-transform duration-[800ms] ease-out motion-reduce:transition-none',
              at(10000) ? 'scale-x-100' : 'scale-x-0'
            )}
          />
        </div>
      </div>
      <div className='grid border-b border-border/50 min-[900px]:grid-cols-4'>
        {REPORT_FIGURES.map((figure, i) => (
          <div
            key={figure.label}
            className={cn(
              FADE,
              shown(at(10800 + i * 350)),
              'grid min-w-0 grid-cols-[minmax(8rem,auto)_minmax(0,1fr)] items-baseline gap-x-3 border-b border-border/50 px-4 py-3.5 last:border-b-0 min-[900px]:flex min-[900px]:flex-col min-[900px]:items-start min-[900px]:gap-2 min-[900px]:border-r min-[900px]:border-b-0 min-[900px]:px-7 min-[900px]:py-6 min-[900px]:last:border-r-0'
            )}
          >
            <Text as='span' variant='figure' className='row-span-2 whitespace-nowrap min-[900px]:order-2'>
              {figure.value}
            </Text>
            <Text as='span' variant='eyebrow' size='sm' tone='muted' className='min-[900px]:order-1'>
              {figure.label}
            </Text>
            <Text as='span' size='lg' leading='snug' tone='muted' className='min-[900px]:order-3'>
              {figure.note}
            </Text>
          </div>
        ))}
      </div>
      <div className='flex flex-col gap-2.5 px-4 py-3.5 min-[900px]:grid min-[900px]:grid-cols-[auto_minmax(0,1fr)_auto] min-[900px]:items-center min-[900px]:gap-8 min-[900px]:px-8 min-[900px]:py-5'>
        <Text as='span' variant='eyebrow' tone='muted'>
          Where the time goes
        </Text>
        <div
          className={cn(
            'flex h-3 origin-left transition-transform duration-700 ease-out motion-reduce:transition-none',
            at(12400) ? 'scale-x-100' : 'scale-x-0'
          )}
        >
          {TIME_SPLIT.map((part, i) => (
            <div
              key={part.label}
              className={i === 0 ? 'bg-foreground' : 'bg-border'}
              style={{ width: `${part.share}%` }}
            />
          ))}
        </div>
        <Text as='span' size='lg'>
          {TIME_SPLIT.map((part, i) => (
            <span key={part.label}>
              {i > 0 ? <span className='text-muted-foreground'> · </span> : null}
              {part.label} <span className='text-muted-foreground'>{part.share}%</span>
            </span>
          ))}
        </Text>
      </div>
    </div>
  )
}

// What Home's Studio window lists: enough milestones and tasks to fill a full-height window.
export const HOME_MILESTONES: readonly StudioMilestone[] = [
  { name: 'checkout-v2', facts: '3 tranches · 1 active · 14 tasks', target: 64 },
  { name: 'log-portable-v1', facts: '2 tranches · 1 active · 9 tasks', target: 40 },
  { name: 'vada-production-v1', facts: '4 tranches · 0 active · 18 tasks', target: 50 },
  { name: 'studio-shell-v1', facts: '3 tranches · 2 active · 11 tasks', target: 72 },
  { name: 'onchain-rewind-v1', facts: '5 tranches · 0 active · 33 tasks', target: 97 },
  { name: 'gates-ring2-v1', facts: '2 tranches · 1 active · 7 tasks', target: 28 }
]

export const HOME_TASKS: readonly StudioTask[] = [
  { id: '#889', title: 'Event schema versioning' },
  { id: '#891', title: 'Synchronous exit write' },
  { id: '#893', title: 'Custom events' },
  { id: '#895', title: 'Streaming parser' },
  { id: '#897', title: 'Log server adapter' },
  { id: '#899', title: 'Event replay' },
  { id: '#901', title: 'Backpressure on the stream' },
  { id: '#903', title: 'Retention policy' },
  { id: '#905', title: 'Redaction rules' },
  { id: '#907', title: 'Report export' },
  { id: '#909', title: 'Follow filters' },
  { id: '#911', title: 'Custom events CLI' }
]

// Home's loop monitor: four tasks at once, so the window and its log are full. Event Replay (#899) and Retention
// policy (#903, in its second round) join the portal's two.
export const HOME_LOOP: LoopScript = {
  tasks: [
    { name: 'Custom events', meta: '#893 · opus', tag: '#893', model: 'opus' },
    { name: 'Streaming parser', meta: '#895 · sonnet', tag: '#895', model: 'sonnet' },
    { name: 'Event replay', meta: '#899 · opus', tag: '#899', model: 'opus' },
    { name: 'Retention policy', meta: '#903 · sonnet', tag: '#903', model: 'sonnet' }
  ],
  start: [
    [
      { dev: 'ok', code: 'run', sec: 'run' },
      { dev: 'pend', code: 'pend', sec: 'pend' }
    ],
    [
      { dev: 'run', code: 'pend', sec: 'pend' },
      { dev: 'pend', code: 'pend', sec: 'pend' }
    ],
    [
      { dev: 'run', code: 'pend', sec: 'pend' },
      { dev: 'pend', code: 'pend', sec: 'pend' }
    ],
    [
      { dev: 'ok', code: 'bad', sec: 'ok' },
      { dev: 'run', code: 'pend', sec: 'pend' }
    ]
  ],
  events: [
    ['11:02', 2, 0, ['dev'], 'ok', '›', 'Developer: round 1 done'],
    ['11:02', 2, 0, ['code', 'sec'], 'run', '›', 'Reviewers dispatched in parallel'],
    ['11:03', 0, 0, ['sec'], 'ok', '✓', 'Security: pass'],
    ['11:03', 0, 0, ['code'], 'bad', '✕', 'Code review: changes requested'],
    ['11:03', 3, 1, ['dev'], 'ok', '›', 'Developer: round 2 done'],
    ['11:04', 1, 0, ['dev'], 'ok', '›', 'Developer: round 1 done'],
    ['11:04', 0, 1, ['dev'], 'run', '›', 'Round 2: developer addressing the findings'],
    ['11:04', 1, 0, ['code', 'sec'], 'run', '›', 'Reviewers dispatched in parallel'],
    ['11:04', 3, 1, ['code', 'sec'], 'run', '›', 'Reviewers dispatched in parallel'],
    ['11:05', 2, 0, ['sec'], 'ok', '✓', 'Security: pass'],
    ['11:05', 1, 0, ['sec'], 'ok', '✓', 'Security: pass'],
    ['11:05', 0, 1, ['dev'], 'ok', '›', 'Developer: round 2 done'],
    ['11:05', 0, 1, ['code', 'sec'], 'run', '›', 'Reviewers dispatched in parallel'],
    ['11:05', 2, 0, ['code'], 'ok', '✓', 'Code review: approved · PR #899 up'],
    ['11:06', 3, 1, ['sec'], 'ok', '✓', 'Security: pass'],
    ['11:06', 1, 0, ['code'], 'ok', '✓', 'Code review: approved · PR #895 up'],
    ['11:06', 3, 1, ['code'], 'ok', '✓', 'Code review: approved · PR #903 up'],
    ['11:06', 0, 1, ['code', 'sec'], 'ok', '✓', 'Both approved, PR #893 up'],
    ['11:06', -1, 0, [], 'ok', '☞', '4 PRs waiting for your merge']
  ],
  status: (count, done) =>
    done
      ? 'PUBLISHED · 4 PRs need your merge'
      : count >= 18
        ? 'RUNNING · 4 PRs up'
        : count >= 17
          ? 'RUNNING · 3 PRs up'
          : count >= 16
            ? 'RUNNING · 2 PRs up'
            : count >= 14
              ? 'RUNNING · 1 PR up'
              : 'RUNNING · 4 tasks'
}

// 03 · Studio, animated the way the portal's StudioSection is: a 420vh runway and one sticky stage; scroll walks the
// window's three views (milestones, tasks, the dev-review loop monitor) while the steps name the active one. The
// stage is one screen tall: the words and steps on the left, the window filling the right. Under reduced motion it
// flows and shows the last view, complete.
function StudioFeatureSection() {
  const ref = useRef<HTMLElement>(null)
  const pinned = !useReducedMotion()
  const pinProgress = usePinProgress(ref)
  const enterProgress = useEnterProgress(ref, 0.9, 0.9)
  const sp = pinned ? pinProgress : enterProgress
  const narrow = useNarrow()
  const stage = sp < 0.28 ? 0 : sp < 0.5 ? 1 : 2
  const current = STUDIO_STEPS[stage] ?? STUDIO_STEPS[0]
  return (
    <section
      ref={ref}
      id='studio'
      className={cn('relative bg-secondary text-secondary-foreground', pinned && 'h-[420vh]')}
    >
      <div className={cn(pinned ? 'sticky top-0 h-dvh overflow-hidden' : 'relative h-dvh')}>
        <div className='mx-auto grid h-full w-full max-w-[82rem] grid-rows-[auto_minmax(0,1fr)] gap-5 px-4 pt-[calc(3.5rem+clamp(0.75rem,3vh,2rem))] pb-[clamp(0.75rem,3vh,2rem)] sm:px-[clamp(1rem,4.5vw,4rem)] min-[900px]:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] min-[900px]:grid-rows-1 min-[900px]:gap-20'>
          <div className='flex flex-col justify-center gap-[clamp(2rem,6vh,4rem)]'>
            <FeatureCopy
              n={3}
              name='Studio'
              line='A live dashboard of every task, check and review, plus the reports.'
              href='/docs/features/studio'
            />
            <ol className='hidden flex-col gap-[clamp(1rem,3vh,1.75rem)] min-[900px]:flex'>
              {STUDIO_STEPS.map((step, index) => (
                <li
                  key={step.title}
                  className={cn(
                    'grid grid-cols-[3px_minmax(0,1fr)] gap-5 transition-opacity duration-300 motion-reduce:transition-none',
                    stage === index ? 'opacity-100' : 'opacity-35'
                  )}
                >
                  <span className='bg-foreground' />
                  <span className='flex flex-col gap-1.5 py-0.5'>
                    <span className='font-mono text-sm uppercase tracking-wider'>{`0${index + 1} · ${step.title}`}</span>
                    <span className='text-xl leading-snug text-muted-foreground'>{step.detail}</span>
                  </span>
                </li>
              ))}
            </ol>
          </div>
          <div className='flex min-h-0 min-w-0 flex-col gap-4'>
            <div className='flex flex-col gap-1.5 border-t-[3px] border-foreground pt-3.5 min-[900px]:hidden'>
              <span className='font-mono text-sm uppercase tracking-wider'>{`0${stage + 1} · ${current.title}`}</span>
              <span className='text-lg leading-snug text-muted-foreground'>{current.detail}</span>
            </div>
            {/* the window is as tall as its content, centred in the column */}
            <div className='flex min-h-0 min-w-0 flex-1 flex-col justify-center' aria-hidden='true'>
              <StudioMock
                fit
                stage={stage}
                milestoneFill={clamp01((sp - 0.04) / 0.2)}
                taskFill={clamp01((sp - 0.3) / 0.18)}
                lines={Math.floor(
                  clamp01((sp - 0.53) / 0.42) * ((narrow ? LOOP_EVENT_COUNT : HOME_LOOP.events.length) + 0.99)
                )}
                narrow={narrow}
                bodyClassName='min-h-0'
                milestones={narrow ? undefined : HOME_MILESTONES}
                tasks={narrow ? undefined : HOME_TASKS}
                loop={narrow ? undefined : HOME_LOOP}
                maxLogRows={12}
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

const STAGES = [
  ['Thinking', 'The Architect turns product work into one milestone'],
  ['Planning', 'The Planner writes every task as an Issue'],
  ['Executing', 'Agents build and review in parallel, every gate runs'],
  ['Self-improvement', 'A report shows where time went and proposes what to fix next']
] as const

// Dev Process, not one of the five features: it follows them, unnumbered. The words and the two links on top; under
// them, full width, the Vinaya process: its four stages, numbered in the theme's orange because each is where a person
// decides. It fits one screen; nothing animates.
function DevProcessSection() {
  return (
    <LandingSection
      id='dev-process'
      background='bg-background text-foreground'
      py='compact'
      className='flex min-h-[calc(100svh-3.5rem)] max-w-[82rem] flex-col justify-center px-4 py-12 sm:px-[clamp(1rem,4.5vw,4rem)] min-[900px]:py-14'
    >
      <div className='flex flex-col gap-6 min-[900px]:gap-10'>
        <div className='flex flex-col gap-3 min-[900px]:flex-row min-[900px]:flex-wrap min-[900px]:items-end min-[900px]:justify-between min-[900px]:gap-x-16 min-[900px]:gap-y-6'>
          <div className='flex min-w-0 flex-col items-start gap-3 min-[900px]:gap-4'>
            <span className='flex items-center gap-4 min-[900px]:gap-5'>
              <DevProcessIcon className={TITLE_ICON} />
              <Heading level={3} weight='normal' variant='headline'>
                Dev Process
              </Heading>
            </span>
            <Text variant='lead' tone='muted' className='max-w-[45rem] text-pretty'>
              The Vinaya process comes with the harness: four stages, every gate runs, every step written down in the
              Log.
            </Text>
          </div>
          <div className='flex flex-wrap gap-x-6 gap-y-1 min-[900px]:gap-8'>
            <FeatureLink href='/docs/dev-process/overview' className='mt-0'>
              Open Dev Process
            </FeatureLink>
            <FeatureLink href='/vinaya-process' className='mt-0'>
              <span className='min-[900px]:hidden'>The Vinaya process</span>
              <span className='hidden min-[900px]:inline'>See the Vinaya process</span>
            </FeatureLink>
          </div>
        </div>

        <div className='flex flex-col border border-border/50 bg-card'>
          <div className='flex flex-col border-b border-border min-[900px]:flex-row min-[900px]:flex-wrap min-[900px]:items-center min-[900px]:justify-between min-[900px]:gap-x-8 min-[900px]:gap-y-4 min-[900px]:border-border/50 min-[900px]:px-7 min-[900px]:py-5'>
            <Text as='span' variant='eyebrow' tone='muted' className='px-4 py-3.5 min-[900px]:p-0'>
              The Vinaya process
            </Text>
            <Text size='lg' tone='muted' className='hidden min-[900px]:block'>
              Four stages, installed with the harness
            </Text>
          </div>

          <ol className='flex flex-col min-[900px]:grid min-[900px]:grid-cols-4'>
            {STAGES.map(([stage, line], i) => (
              <li
                key={stage}
                className='grid grid-cols-[2.25rem_minmax(0,1fr)] gap-x-2 gap-y-1 border-t border-border/50 px-4 py-2.5 first:border-t-0 min-[900px]:flex min-[900px]:flex-col min-[900px]:gap-3 min-[900px]:border-t-0 min-[900px]:border-r min-[900px]:px-7 min-[900px]:pt-6 min-[900px]:pb-7 min-[900px]:last:border-r-0'
              >
                <Text as='span' variant='title' family='mono' tone='accent'>
                  0{i + 1}
                </Text>
                <span className='flex flex-col gap-0.5 min-[900px]:gap-3'>
                  <Text as='span' variant='title' className='min-[900px]:mt-2'>
                    {stage}
                  </Text>
                  <Text as='span' size='lg' leading='snug' tone='muted'>
                    {line}
                  </Text>
                </span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </LandingSection>
  )
}

/** The five features, one section each, in order, opened by the "Five features, one harness" heading and its index. */
export function FeatureSections() {
  return (
    <>
      <FeaturesIntroSection />
      <LogTelemetrySection />
      <StudioFeatureSection />
      <SelfImprovementSection />
      <ConfigurationSection />
      {/* not one of the five: the way the harness runs, right after them */}
      <DevProcessSection />
    </>
  )
}
