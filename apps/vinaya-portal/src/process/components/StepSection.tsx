'use client'

import {
  ArrowLeft,
  ArrowRight,
  Cloud,
  Database,
  LayoutDashboard,
  Monitor,
  Server,
  Smartphone,
  SquareTerminal,
  Workflow
} from 'lucide-react'
import { type ReactNode, useMemo } from 'react'
import { Button, Card, RadioGroup } from '@/ui/components'
import { cn } from '@/ui/lib/utils'
import { Heading, Text } from '@/ui/shared'
import { ImproverCards } from '../diagram/stages'
import { flows } from '../fixtures'
import { checkoutProjects, type Product } from '../fixtures/lifecycle'
import { LINES_END, shownAt, stepLines } from '../replay'
import { toneBg, toneMarker, toneText } from '../tone'
import type { Brief, Environment, FlowKey, Step, Tone } from '../types'
import { fillEnv, toneOfStage, trackerLabel } from '../types'
import { BrandIcon } from './BrandIcon'
import { ChatWindow } from './ChatWindow'
import { ChoiceCard } from './cards'
import { Eyebrow } from './primitives'
import { SetupSlide } from './SetupSlide'

export { execLines } from '../replay'

/**
 * The command a stage runs, as a terminal line beside its title: typed in letter
 * by letter as the reader scrolls in (`progress` 0..1 types it over the first
 * 12%), the cursor resting at its end. Under reduced motion it is typed and still.
 */
function CommandLine({
  command,
  progress = 1,
  big = false,
  tone
}: {
  command: string
  progress?: number
  /** Complex work: no box, a small muted mono line under the title. */
  big?: boolean
  /** The stage's tone, on the cursor. */
  tone: Tone
}) {
  const typed = command.slice(0, Math.round(command.length * Math.min(1, Math.max(0, progress / 0.12))))
  if (big)
    return (
      <div className='flex items-center gap-[0.444rem] font-mono text-sm text-muted-foreground'>
        <span className='sr-only'>{command}</span>
        <SquareTerminal aria-hidden className='size-[0.889rem] shrink-0' />
        <span aria-hidden className='whitespace-pre leading-5'>
          {typed}
          <span
            className={cn('site-cursor ml-0.5 inline-block h-[1em] w-[0.5rem] translate-y-[0.15em]', toneBg[tone])}
          />
        </span>
      </div>
    )
  return (
    <Card className='flex shrink-0 items-center gap-3 px-4 py-3' aria-label={command}>
      <SquareTerminal aria-hidden className='size-5 text-muted-foreground' />
      <span aria-hidden className='whitespace-pre font-mono text-lg text-foreground'>
        {typed}
        <span
          className={cn('site-cursor ml-0.5 inline-block h-[1.1em] w-[0.55ch] translate-y-[0.15em]', toneBg[tone])}
        />
      </span>
    </Card>
  )
}

/** The copy block of a step: eyebrow, title, text. */
export function StepHeader({
  step,
  env = null,
  big = false,
  className
}: {
  step: Step
  env?: Environment | null
  /** The /vinaya-process landing's type: its tag, its big light titles, its lead. */
  big?: boolean
  className?: string
}) {
  const tone = toneOfStage[step.stage]
  if (big)
    return (
      <div className={cn('grid gap-4', className)}>
        <Text as='span' variant='eyebrow' className={toneText[tone]}>
          {step.eyebrow}
        </Text>
        <Heading level={2} weight='normal' variant='headline' className='whitespace-pre-line text-balance'>
          {fillEnv(step.title, env)}
        </Heading>
        <Text variant='lead' tone='muted' className='max-w-[40ch]'>
          {fillEnv(step.text, env)}
        </Text>
        {step.emphasis && (
          <Text size='xl' leading='normal' className='max-w-[40ch]'>
            {fillEnv(step.emphasis, env)}
          </Text>
        )}
      </div>
    )
  return (
    <div className={cn('grid gap-2', className)}>
      <Eyebrow tone={tone}>{step.eyebrow}</Eyebrow>
      {/* a newline in the title is a line break the copy asks for */}
      <Heading level={2} size={step.kind === 'intro' ? '4xl' : '3xl'} className='whitespace-pre-line text-balance'>
        {fillEnv(step.title, env)}
      </Heading>
      <Text tone='muted' className='max-w-[58ch]'>
        {fillEnv(step.text, env)}
      </Text>
      {step.emphasis && (
        <Text weight='semibold' className='max-w-[58ch]'>
          {fillEnv(step.emphasis, env)}
        </Text>
      )}
    </div>
  )
}

/** Complex work's titles: the landing's section heading (light, tight), stepped down a size below 1280 for the column. */
/**
 * A section's brief, landing-page style: the stage number, the stage in big
 * type, then a few bullets: how it starts, what it does, what comes out. The bullets appear one by one as the reader scrolls into the step.
 */
function BriefHeader({
  brief,
  tone,
  env = null,
  progress = 1,
  big = false
}: {
  brief: Brief
  tone: Tone
  env?: Environment | null
  progress?: number
  /** The /vinaya-process landing's type: its tag, its big light titles, its lead. */
  big?: boolean
}) {
  // a real command sits beside the title as a terminal line; an automatic stage shows none, and its bullets say how it runs
  const automatic = brief.command === 'Automatic'
  const stage = brief.n === undefined ? 'Built into the harness' : `Stage ${brief.n}`
  if (big)
    // Complex work: the stage, its title, the command as a small line under it, what the stage does as a muted lead,
    // then what comes out after an arrow. Each part fades in as the scroll reaches it, as the bullets did.
    return (
      <div className='grid'>
        <Text as='span' variant='eyebrow' className={toneText[tone]}>
          {stage}
        </Text>
        <Heading level={2} weight='normal' variant='headline' className='mt-[0.556rem] text-balance'>
          {brief.title}
        </Heading>
        {!automatic && (
          <div className='mt-[0.778rem]'>
            <CommandLine command={brief.command} progress={progress} big tone={tone} />
          </div>
        )}
        {brief.subtitle && (
          <Text size='lg' tone='muted' className='mt-[0.778rem]'>
            {brief.subtitle}
          </Text>
        )}
        {brief.does && (
          <Text tone='muted' size='md' leading='normal' className='mt-[1.111rem] max-w-[60ch]'>
            {fillEnv(brief.does, env)}
          </Text>
        )}
        <div
          className={cn(
            'grid grid-cols-[1.333rem_minmax(0,1fr)] items-start gap-x-[0.667rem] transition-opacity duration-300',
            brief.does ? 'mt-[0.889rem]' : 'mt-[1.111rem]'
          )}
          style={{ opacity: progress >= (brief.does ? 0.04 : 0) ? 1 : 0 }}
        >
          <ArrowRight aria-hidden className='mt-[0.167rem] size-[1.333rem]' />
          <Text variant='title' weight='medium'>
            {fillEnv(brief.output, env)}
          </Text>
        </div>
      </div>
    )
  const items: { key: string; node: ReactNode }[] = [
    ...(brief.does ? [{ key: 'does', node: fillEnv(brief.does, env) }] : []),
    { key: 'output', node: `Output: ${fillEnv(brief.output, env)}` }
  ]
  return (
    <div className='grid gap-4'>
      <div className='grid gap-1'>
        <Eyebrow tone={tone}>{stage}</Eyebrow>
        <div className='flex flex-wrap items-center justify-between gap-4'>
          <Heading level={2} size='4xl' className='text-balance'>
            {brief.title}
          </Heading>
          {!automatic && <CommandLine command={brief.command} progress={progress} tone={tone} />}
        </div>
        {brief.subtitle && (
          <Text size='lg' tone='muted'>
            {brief.subtitle}
          </Text>
        )}
      </div>
      <ul className={cn('grid list-disc gap-2 pl-6', toneMarker[tone])}>
        {items.map((it, i) => (
          <li
            key={it.key}
            className='transition-opacity duration-300'
            style={{ opacity: progress >= i * 0.04 ? 1 : 0 }}
          >
            <Text as='span' size='xl'>
              {it.node}
            </Text>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The four flows as one radio group of cards: two by two on a desktop, one per row below. */
export function FlowCards({ flow, onPick }: { flow: FlowKey | null; onPick: (f: FlowKey) => void }) {
  const all = Object.values(flows)
  return (
    <RadioGroup
      aria-label='What you have to deploy next'
      value={flow}
      onValueChange={(key) => onPick(key as FlowKey)}
      className='grid grid-cols-1 gap-[0.667rem] xl:grid-cols-2 xl:gap-[0.889rem]'
    >
      {all.map((f) => (
        <ChoiceCard key={f.key} flow={f} pressed={f.key === flow} />
      ))}
    </RadioGroup>
  )
}

/** The footer of step 2: Back, then Start, which waits for a flow. Start takes the room on a phone. */
export function FlowActions({
  flow,
  onBack,
  onStart
}: {
  flow: FlowKey | null
  onBack?: () => void
  onStart: () => void
}) {
  return (
    <>
      {onBack && (
        <Button variant='outline' onClick={onBack} hoverScale={1} tapScale={1}>
          <ArrowLeft />
          Back
        </Button>
      )}
      <Button onClick={onStart} disabled={!flow} hoverScale={1} tapScale={1} className='max-md:flex-1'>
        Start
        <ArrowRight />
      </Button>
    </>
  )
}

/** The second setup step on its own (as `/system` shows it): the four flows, then Back and Start. */
export function FlowChoice({
  flow,
  onPick,
  onBack,
  onStart
}: {
  /** The picked flow; null until the reader clicks one. Start waits for it. */
  flow: FlowKey | null
  onPick: (f: FlowKey) => void
  onBack?: () => void
  onStart: () => void
}) {
  return (
    <SetupSlide
      n={2}
      title='What you have to deploy next'
      actions={<FlowActions flow={flow} onBack={onBack} onStart={onStart} />}
    >
      <FlowCards flow={flow} onPick={onPick} />
    </SetupSlide>
  )
}

/**
 * One step at a scroll `progress` (0..1), fully from data. It fills the
 * height its parent gives it: the copy on top, and on the last step the
 * Improver's cards below (the diagram's own `ImproverCards`, in place from
 * the start, shown once the lines are done). Outputs, task states and closing
 * banners are the animation's to show. The window takes whatever height is
 * left; that height never changes while the lines type in, so nothing moves.
 */
/**
 * The flows whose improve step shows no Improver cards under its window. Complex work's animation draws the stats and
 * the new Project itself; Simple task ends on its window. Medium work and Hot issue still show the cards.
 */
const HIDES_IMPROVER_CARDS: ReadonlySet<FlowKey> = new Set<FlowKey>(['feature', 'backlog'])

export function StepView({
  step,
  flow,
  env,
  progress,
  onMap,
  className
}: {
  step: Step
  flow: FlowKey
  env: Environment
  progress: number
  /** The walk's last step offers the whole process, full screen. */
  onMap?: () => void
  className?: string
}) {
  const tone = toneOfStage[step.stage]
  // The big step header (stage, big title, the command as a small line, a grey lead, → the output) and the window's
  // larger type, in every flow: an opening or closing step without a brief takes Complex work's tag, title and lead.
  const big = true
  // Complex work's layout alone: below 1280 its window runs to the column's edges, so the column has no side padding
  // and the step pads its own words. The other flows keep the column's padding.
  const edge = flow === 'feature'
  const pad = edge ? 'max-xl:px-4 md:max-xl:pl-6 md:max-xl:pr-4' : undefined
  // The conversation names the reader's tools too ({tracker}, {project}).
  const lines = useMemo(
    () => stepLines(step, flow, env.agent).map((l) => ({ ...l, text: fillEnv(l.text, env) })),
    [step, flow, env]
  )
  const { full, partial } = shownAt(lines.length, progress)
  const reveal = cn(
    'transition-opacity duration-300',
    progress >= LINES_END ? 'opacity-100' : 'pointer-events-none opacity-0'
  )
  return (
    <section
      className={cn(
        'flex min-h-0 w-full flex-col',
        big ? 'gap-[1.333rem]' : step.kind === 'improve' ? 'gap-4' : 'gap-5',
        // Complex work's opening on a phone sits at the top, its dashboard under the words
        step.kind === 'intro' && (edge ? 'md:justify-center' : 'justify-center'),
        className
      )}
    >
      <div className={pad}>
        {step.brief ? (
          <BriefHeader brief={step.brief} tone={tone} env={env} progress={progress} big={big} />
        ) : (
          <StepHeader step={step} env={env} big={big} />
        )}
      </div>
      {/* below 768 the life-cycle animation is hidden: the opening shows its first picture, the six Projects */}
      {edge && step.kind === 'intro' && (
        <div className={cn(pad, 'md:hidden')}>
          <UpstreamCard env={env} progress={progress} />
        </div>
      )}
      {onMap && (
        <div className={pad}>
          <Button variant='outline' size='lg' onClick={onMap}>
            <Workflow aria-hidden />
            See the whole process
          </Button>
        </div>
      )}
      {step.kind !== 'intro' && (
        <ChatWindow
          fixed
          className={cn('min-h-36 flex-1', edge && 'max-xl:[&>*]:border-x-0')}
          large={big}
          surface={step.surface ?? 'terminal'}
          lines={lines}
          visible={full}
          partial={partial}
          env={env}
          tone={tone}
        />
      )}
      {step.kind === 'improve' && !HIDES_IMPROVER_CARDS.has(flow) && (
        <div className={reveal}>
          <ImproverCards moment={{ flow, stage: 'improve' }} />
        </div>
      )}
    </section>
  )
}

const productIcon: Record<Product, ReactNode> = {
  cloud: <Cloud />,
  server: <Server />,
  database: <Database />,
  phone: <Smartphone />,
  monitor: <Monitor />,
  dashboard: <LayoutDashboard />
}

/**
 * Complex work's opening on a phone: the life-cycle animation's first picture, still. The reader's tracker with the
 * target, then its six Projects (Epics in Jira), each with the marks of the products it touches. The tiles light one
 * by one as the step scrolls; under reduced motion the walk's progress is already 1, so all are lit.
 */
function UpstreamCard({ env, progress }: { env: Environment; progress: number }) {
  const tracker = trackerLabel[env.tracker]
  const unit = env.tracker === 'jira' ? 'Epics' : 'Projects'
  return (
    <Card role='img' aria-label={`${tracker}, Checkout v2: six ${unit}`} variant='square' className='gap-0 py-0'>
      <div className='flex h-[2.444rem] items-center gap-[0.556rem] border-b border-border px-[0.778rem] text-sm font-medium'>
        <BrandIcon brand={env.tracker} />
        {tracker}
        <span className='text-muted-foreground'>/</span>
        Checkout v2
      </div>
      <div className='grid grid-cols-2 gap-[0.444rem] p-[0.667rem]'>
        {checkoutProjects.map((p, i) => (
          <div
            key={p.name}
            className={cn(
              'grid content-start gap-[0.556rem] border bg-background p-[0.667rem] transition-colors duration-150 ease-out motion-reduce:transition-none',
              progress >= 0.05 + i * 0.1 ? 'border-foreground' : 'border-foreground/40'
            )}
          >
            <span className='flex gap-[0.444rem] text-muted-foreground [&_svg]:size-[1rem] [&_svg]:stroke-[1.75]'>
              {p.products.map((m) => (
                <span key={m}>{productIcon[m]}</span>
              ))}
            </span>
            <span className='text-sm font-semibold leading-5'>{p.name}</span>
          </div>
        ))}
      </div>
    </Card>
  )
}
