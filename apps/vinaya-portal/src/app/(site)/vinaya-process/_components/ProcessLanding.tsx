'use client'

import { ArrowDown, ArrowRight, CircleCheck, Lightbulb, Play } from 'lucide-react'
import { type ReactNode, type RefObject, useCallback, useEffect, useRef, useState } from 'react'
import { BrandIcon } from '@/process/components/BrandIcon'
import { toneText } from '@/process/tone'
import type { Tone } from '@/process/types'
import { easeInOutQuad, progressBetween } from '@/ui/lib/math'
import { cn } from '@/ui/lib/utils'
import { Heading, Logo, Text } from '@/ui/shared'
import { LetterReveal } from '../../_components/LetterReveal'
import { ButtonLink } from '../../_components/landing/ButtonLink'
import { useEnterProgress, useReducedMotion, useSeen } from '../../_components/landing/LandingInteractions'
import { WipeReveal } from '../../_components/landing/WipeReveal'
import { type CrossingHandle, EnergyCrossing } from './EnergyCrossing'
import { type ProcessStep, ProcessSteps } from './ProcessSteps'
import { ACTION, SECTION_Y, WRAP } from './process-styles'
import { StudioBridge } from './StudioBridge'
import { useFitToPin, usePinnedFrames } from './use-pinned-progress'

// /vinaya-process: what Vinaya brings, every kind of deploy, product beside Vinaya, the four stages with the Studio bridge between 2 and 3, the
// gates, the roles with the five decisions a person keeps, and the way in. Backgrounds alternate background /
// secondary down to the CTA.

// This page draws its stages in one ink, the way Home draws its steps: every stage uses the `log` tone, the theme's
// `primary` (near black in light, near white in dark). The only other colours are meaningful ones: the theme's `ring`
// (orange) where a person decides, product included, and `success` / `destructive` for checks that passed or caught
// something. The diagrams keep their own stage palette.
const TONE = { think: 'log', exec: 'log', retro: 'log', hot: 'log' } as const satisfies Record<string, Tone>

const DEPLOYS = [
  {
    tone: TONE.exec,
    // The card's top bar: ring for planned work, the page's info blue for a backlog Issue, destructive for hot.
    bar: 'bg-ring',
    tag: 'Deploy complex work',
    name: 'Complex work',
    line: 'A feature with product specs: one milestone, several tranches, many tasks.'
  },
  {
    tone: TONE.exec,
    bar: 'bg-ring',
    tag: 'Deploy medium work',
    name: 'Medium work',
    line: 'An engineering need with several tasks: one standalone tranche.'
  },
  {
    tone: TONE.exec,
    bar: 'bg-chart-2',
    tag: 'Deploy a backlog issue',
    name: 'Simple task',
    line: 'A single fix found while working: one backlog Issue.'
  },
  {
    tone: TONE.hot,
    bar: 'bg-destructive',
    tag: 'Deploy a hot issue',
    name: 'Hot issue',
    line: 'Urgent: a light brief, no Planner, the same gates and the same record.'
  }
] as const

const Muted = ({ children }: { children: ReactNode }) => <span className='text-muted-foreground'>{children}</span>

// What product hands over, twice on the track: the release Vinaya builds, then the one the Improver's proposal
// becomes, each with its spec docs by short name.
const RELEASES = {
  first: {
    chip: 'Scope closed',
    release: 'Checkout v2',
    specs: ['Ledger', 'Refunds', 'Mobile pay', 'Charge once', 'Fraud checks', 'Web checkout']
  },
  next: {
    chip: 'Proposal accepted',
    release: 'Checkout v2.1',
    specs: ['Partial refunds', 'Ledger exports', 'Mobile pay retries', 'Refund webhooks', 'Fraud rules']
  }
} as const

/** The product side's two steps, on Shipping's rhythm: Deciding ends in a success chip (the scope is closed, or the
 * proposal accepted); Defining hands over the release, drawn under the steps at the panel's full width. */
function productSteps({ chip }: (typeof RELEASES)[keyof typeof RELEASES]): readonly ProcessStep[] {
  return [
    {
      title: 'Deciding',
      circle: 'dash',
      mark: <Lightbulb className='size-5' strokeWidth={1.75} />,
      chipStyle: 'bare',
      chip: (
        <span className='inline-flex h-11 items-center gap-2 border border-success/40 px-3 text-lg leading-none text-success'>
          <CircleCheck className='size-5 shrink-0' strokeWidth={1.75} aria-hidden />
          {chip}
        </span>
      )
    },
    {
      title: 'Defining',
      circle: 'dash',
      mark: <ArrowRight className='size-5' strokeWidth={1.75} />
    }
  ]
}

/** One spec, drawn as a sheet of paper: its top corner folded, its name, and a few ruled lines of text under it. */
function SpecSheet({ name }: { name: string }) {
  return (
    <span className='relative flex min-w-0 flex-col gap-2.5 bg-ring/10 p-3 pr-6 [clip-path:polygon(0_0,calc(100%-var(--spacing)*5)_0,100%_calc(var(--spacing)*5),100%_100%,0_100%)]'>
      {/* the folded corner */}
      <span aria-hidden='true' className='absolute top-0 right-0 size-5 bg-ring/30' />
      <span className='font-mono text-sm uppercase leading-none tracking-widest text-ring'>Spec</span>
      <span className='line-clamp-2 text-base font-medium leading-tight text-foreground'>{name}</span>
      {/* the ruled lines; dropped on a phone, where the panel must fit the screen */}
      <span aria-hidden='true' className='hidden flex-col gap-1.5 pt-1 sm:flex'>
        <span className='h-0.5 w-full bg-foreground/15' />
        <span className='h-0.5 w-4/5 bg-foreground/15' />
        <span className='h-0.5 w-3/5 bg-foreground/15' />
      </span>
    </span>
  )
}

/** The release's spec docs, the panel's full width: two to a row on a phone, three where the panel is wider. */
function ReleaseDocs({ release, specs, shown }: { release: string; specs: readonly string[]; shown: boolean }) {
  return (
    <div
      className={cn(
        'flex flex-col gap-3 transition duration-400 motion-reduce:transition-none',
        shown ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'
      )}
    >
      <span className='font-mono text-sm uppercase tracking-widest text-ring'>{release}</span>
      <div className='grid grid-cols-2 gap-2 sm:grid-cols-3'>
        {specs.map((spec) => (
          <SpecSheet key={spec} name={spec} />
        ))}
      </div>
    </div>
  )
}

const VINAYA_STAGES = [
  {
    tone: TONE.think,
    title: 'Thinking',
    line: 'Architect and Planner prepare the mission.'
  },
  { tone: TONE.exec, title: 'Executing', line: 'Each task runs in a loop, and every gate runs.' },
  { tone: TONE.retro, title: 'Retrospecting', line: 'On every merge the work is closed and archived.' },
  {
    tone: TONE.hot,
    title: 'Self-improving',
    line: 'The Improver learns and proposes projects.'
  }
] as const

const STAGE_ONE: readonly ProcessStep[] = [
  {
    title: 'Architect',
    line: 'Sets the milestone and its tranches',
    chip: (
      <>
        <span>checkout-v2</span>
        <Muted>· 3 tranches</Muted>
      </>
    )
  },
  {
    title: 'Planner',
    line: 'Reads the real specs and the real code',
    chip: (
      <>
        <span>52 tasks</span>
        <Muted>· each one an Issue</Muted>
      </>
    )
  }
]

const STAGE_TWO: readonly ProcessStep[] = [
  {
    title: 'Developer',
    line: 'Builds the task',
    chip: (
      <>
        <span>code</span>
        <span className='text-success'>+203</span>
        <span className='text-destructive'>−67</span>
      </>
    )
  },
  { title: 'Reviewers', line: 'Fresh agents check it', chip: <span>✓ review approved · security pass</span> },
  { title: 'Gates', line: 'Ring 0 · Ring 1 · Ring 2', chipStyle: 'ok', chip: <span>✓ every rule green</span> }
]

const STAGE_THREE: readonly ProcessStep[] = [
  {
    title: 'Merged and archived',
    line: 'The Archivist closes each task on merge',
    chipStyle: 'term',
    chip: <span className='text-ring'>☞ checkout-v2 landed on main</span>
  },
  {
    title: 'Tranches and milestone closed',
    line: 'The Tranche Archivist closes each finished tranche',
    chip: (
      <>
        <span>3 tranches archived</span>
        <Muted>·</Muted>
        <span>milestone closed</span>
      </>
    )
  }
]

const STAGE_FOUR: readonly ProcessStep[] = [
  {
    title: 'The report',
    line: 'What the Log adds up to',
    chip: (
      <>
        <span>34 min per task</span>
        <Muted>·</Muted>
        <span>19 of 52 second rounds</span>
        <Muted>·</Muted>
        <span className='text-destructive'>418 caught</span>
      </>
    )
  },
  {
    title: 'The Improver proposes',
    line: 'Most extra rounds come from one gate',
    chip: <span>Run the doc gate before push</span>
  },
  {
    title: 'A person approves',
    line: 'And it goes back to product',
    circle: 'ring',
    chipStyle: 'ring',
    chip: <span>Linear · a new Project</span>
  }
]

// The three rings Vinaya's 37 core checks run in (The Vinaya process — definition §17): 25 at commit and push,
// 12 on the pull request and on every Issue write, and the audits after merge.
const GATE_STEPS: readonly ProcessStep[] = [
  {
    title: 'Ring 0 · your machine',
    line: '25 checks at commit and push, before work leaves the session',
    chip: <span>✓ commit · push</span>
  },
  {
    title: 'Ring 1 · the code host',
    line: '12 checks on the pull request and on every Issue write; merge waits until they pass',
    chipStyle: 'ring',
    chip: <span>PR #473 · ready for your approval</span>
  },
  {
    title: 'Ring 2 · after merge',
    line: 'Audits turn drift from any writer into findings',
    chip: <span>merged · audited</span>
  }
]

const GATE_FIGURES = [
  ['37', 'checks in three rings'],
  ['17', 'are generic, for every process'],
  ['20', 'are Vinaya’s own']
] as const

// Who does what (The Vinaya process — definition §14), in the order work meets them.
const ROLES = [
  ['Architect', 'Thinking', 'Sets the milestone and names its tranches', 'Agent'],
  ['Planner', 'Thinking', 'Reads the code first, writes each task as an Issue', 'Agent'],
  ['Operator', 'Executing', 'Starts, watches, resumes and cancels tasks; never plans or rules', 'Agent or person'],
  ['Developer', 'Executing', 'Builds one task in a sandbox, through the controller’s tools', 'Agent'],
  ['Reviewer and Security', 'Executing', 'Judge the change, fresh each round, never talking to each other', 'Agents'],
  ['Archivist and Tranche Archivist', 'Retrospecting', 'Close the task, then the tranche, after merge', 'Agents']
] as const

const DECISIONS = [
  ['Approve the plan', 'Before any task is dispatched'],
  ['Rule at a pause', 'When a task cannot continue safely'],
  ['Ask for review on a hot Issue', 'Per Issue, the Principal’s call'],
  ['Merge', 'Only once every gate is green'],
  ['Adopt an improvement', 'The Improver proposes, the Principal approves']
] as const

function SectionIntro({
  eyebrow,
  title,
  line,
  className
}: {
  eyebrow: string
  title: string
  line: string
  className?: string
}) {
  return (
    <div className={cn('flex max-w-4xl flex-col gap-5', className)}>
      <Text as='span' variant='eyebrow' tone='muted'>
        {eyebrow}
      </Text>
      <Heading level={2} weight='normal' variant='headline'>
        {title}
      </Heading>
      <Text variant='lead' tone='muted'>
        {line}
      </Text>
    </div>
  )
}

const HERO_TITLE = 'Deploy complex features with agents you can’t blindly trust'

// The hero's entrance, about 1.2s, with the site's own reveals: the title's letters
// rise in reading order so it lands line by line (from 150ms, 11ms apart), then the line and the buttons fade up
// (700ms and 850ms, 400ms each). Under reduced motion everything shows at once.
const TITLE_STEP_MS = 11
const TITLE_START = Math.round(150 / TITLE_STEP_MS)
const ENTER = 'transition duration-400 ease-out motion-reduce:transition-none'

function Hero() {
  const [on, setOn] = useState(false)
  useEffect(() => {
    const frame = requestAnimationFrame(() => setOn(true))
    return () => cancelAnimationFrame(frame)
  }, [])
  const up = on ? 'translate-y-0 opacity-100' : 'translate-y-3 opacity-0'
  return (
    <section className='flex min-h-[calc(100svh-3.5rem)] flex-col justify-center bg-background py-14 text-foreground'>
      <div className={WRAP}>
        <div className='flex flex-col items-center gap-7 text-center'>
          <Heading
            level={1}
            weight='normal'
            aria-label={HERO_TITLE}
            variant='display'
            className='max-w-5xl text-balance motion-reduce:[&_span]:transition-none'
          >
            <span aria-hidden='true'>
              <LetterReveal text={HERO_TITLE} delayStepMs={TITLE_STEP_MS} startIndex={TITLE_START} />
            </span>
          </Heading>
          <Text
            variant='lead'
            tone='muted'
            className={cn('max-w-3xl text-balance delay-700 motion-reduce:delay-0', ENTER, up)}
          >
            Vinaya plans the work, checks every change before it merges, and measures every deploy, so the process gets
            better each time.
          </Text>
          <div
            className={cn(
              'flex w-full flex-wrap justify-center gap-3.5 pt-2 delay-850 motion-reduce:delay-0',
              ENTER,
              up
            )}
          >
            <ButtonLink href='/vinaya-process/demo' size='xl' className={ACTION}>
              <Play className='size-4' aria-hidden />
              Play the interactive demo
            </ButtonLink>
          </div>
        </div>
      </div>
    </section>
  )
}

// "What Vinaya brings" plays in once as it comes up the screen, with the site's own reveals: the eyebrow fades in,
// the title wipes in left to right (WipeReveal, as Home's titles do), the line fades up 300ms later; then the four
// kinds of deploy, 120ms apart, each drawing its coloured rule left to right with its words rising in behind it.
// Under reduced motion everything shows at once.
const CARD_DELAYS = ['delay-0', 'delay-120', 'delay-240', 'delay-360'] as const
const CARD_WORD_DELAYS = ['delay-200', 'delay-320', 'delay-440', 'delay-560'] as const

function ShipAllDay() {
  const intro = useRef<HTMLDivElement>(null)
  const cards = useRef<HTMLUListElement>(null)
  const introIn = useSeen(intro, 0.8)
  const cardsIn = useSeen(cards, 0.85)
  const rise = (on: boolean) => (on ? 'translate-y-0 opacity-100' : 'translate-y-3 opacity-0')
  return (
    <section className={cn('bg-secondary text-foreground', 'py-21 sm:py-35.5')}>
      <div className={cn(WRAP, 'flex flex-col gap-19.5')}>
        <div ref={intro} className='flex max-w-4xl flex-col gap-5'>
          <Text
            as='span'
            variant='eyebrow'
            tone='muted'
            className={cn(
              'transition-opacity duration-500 ease-out motion-reduce:transition-none',
              introIn ? 'opacity-100' : 'opacity-0'
            )}
          >
            What Vinaya brings
          </Text>
          <Heading level={2} weight='normal' variant='headline'>
            <WipeReveal>Ship all day. Break nothing.</WipeReveal>
          </Heading>
          <Text variant='lead' tone='muted' className={cn(ENTER, 'delay-300 motion-reduce:delay-0', rise(introIn))}>
            You deploy all day, and agents write most of the code. Vinaya puts every deploy, from a hot fix to a whole
            feature, through the same plan, the same gates and the same record.
          </Text>
        </div>
        <ul ref={cards} className='m-0 grid list-none gap-7 p-0 sm:grid-cols-2 sm:gap-11 lg:grid-cols-4'>
          {DEPLOYS.map((deploy, i) => (
            <li key={deploy.name} className='relative flex flex-col gap-3 pt-7'>
              <span
                aria-hidden='true'
                className={cn(
                  'absolute inset-x-0 top-0 h-1 origin-left transition-transform duration-600 ease-out motion-reduce:transition-none',
                  deploy.bar,
                  CARD_DELAYS[i],
                  'motion-reduce:delay-0',
                  cardsIn ? 'scale-x-100' : 'scale-x-0'
                )}
              />
              <span
                className={cn(
                  'flex flex-col gap-3',
                  ENTER,
                  CARD_WORD_DELAYS[i],
                  'motion-reduce:delay-0',
                  rise(cardsIn)
                )}
              >
                <Text as='span' variant='eyebrow' className={toneText[deploy.tone]}>
                  {deploy.tag}
                </Text>
                <span className='text-3xl leading-none tracking-tight'>{deploy.name}</span>
                <span className='text-lg leading-normal text-muted-foreground'>{deploy.line}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

// The two panels' own titles, large enough to read from across the room.
// The track's pieces at every width: a panel is a phone's width (sized to the column from `sm` up), a gap is wide
// enough for its label and line.
const PANEL_W = 'w-80 shrink-0 sm:w-108 lg:w-120'
const GAP_W = 'w-44 shrink-0 lg:w-56'

/** The product panel, outside Vinaya, in the ring; its steps light as `progress` runs. */
function ProductPanel({ release, progress }: { release: keyof typeof RELEASES; progress?: number }) {
  return (
    <div className='flex flex-1 flex-col gap-3'>
      <div className='flex flex-1 flex-col gap-5 border border-dashed border-ring/40 bg-background p-6'>
        <Heading level={3} weight='normal' variant='title' tone='accent' className='flex items-center gap-3'>
          Product
          <BrandIcon brand='linear' className='size-7' />
          <BrandIcon brand='jira' className='size-7' />
        </Heading>
        <ProcessSteps steps={productSteps(RELEASES[release])} progress={progress} size='compact' />
        {/* lit with Defining, the last step: ProcessSteps lights it as its fill reaches the end */}
        <ReleaseDocs
          release={RELEASES[release].release}
          specs={RELEASES[release].specs}
          shown={progress === undefined || progress >= 0.86}
        />
      </div>
    </div>
  )
}

/** Vinaya's panel, headed by the Vinaya logo: dimmed until reached, then its frame turns ink and its four steps light
 * one by one. */
function VinayaPanel({ lit, progress, logoUrl }: { lit: boolean; progress?: number; logoUrl: string | null }) {
  return (
    <div className='flex flex-1 flex-col gap-3'>
      <div
        className={cn(
          'flex flex-1 flex-col gap-5 border bg-background p-6 transition-colors duration-300 motion-reduce:transition-none',
          lit ? 'border-foreground/25' : 'border-border/50'
        )}
      >
        <Heading
          level={3}
          weight='normal'
          variant='title'
          tone={lit ? 'foreground' : 'muted'}
          className='flex items-center gap-3 transition-colors duration-300 motion-reduce:transition-none'
        >
          <Logo dark={logoUrl ?? undefined} alt='Vinaya' size='h-7' />
          Shipping
        </Heading>
        <ProcessSteps
          steps={VINAYA_STAGES.map((stage, index) => ({ ...stage, circle: 'tone', mark: index + 1 }))}
          progress={progress}
          size='compact'
        />
      </div>
    </div>
  )
}

/** True on a phone (below Tailwind's `sm`, 40rem): there the track runs down the screen instead of across it. */
function useVerticalTrack() {
  const [vertical, setVertical] = useState(false)
  useEffect(() => {
    const query = window.matchMedia('(max-width: 39.99rem)')
    const update = () => setVertical(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return vertical
}

/**
 * Where the track stands, along its own direction (across, or down when `vertical`): the panels' centres in the track
 * (`data-panel`), the first panel's length, the pin's length and the column's leading edge (`ruler`, a WRAP inside
 * the pin), all in the track's own unzoomed pixels. Re-measured on every resize.
 */
function useTrackGeometry(
  track: RefObject<HTMLDivElement | null>,
  ruler: RefObject<HTMLDivElement | null>,
  vertical: boolean
) {
  const [geo, setGeo] = useState({ centers: [0, 0, 0], lengths: [0, 0, 0], panel: 0, view: 0, pad: 0, rem: 16 })
  useEffect(() => {
    const el = track.current
    const block = el?.parentElement
    const pin = block?.parentElement
    if (!el || !block || !pin) return
    const measure = () => {
      const zoom = Number.parseFloat(getComputedStyle(block).zoom) || 1
      const panels = [...el.querySelectorAll<HTMLElement>(':scope > [data-panel]')]
      const pinLeft = pin.getBoundingClientRect().left
      setGeo(
        vertical
          ? {
              centers: panels.map((panel) => panel.offsetTop + panel.offsetHeight / 2),
              lengths: panels.map((panel) => panel.offsetHeight),
              panel: panels[0]?.offsetHeight ?? 0,
              view: pin.clientHeight,
              rem: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
              pad: 0
            }
          : {
              centers: panels.map((panel) => panel.offsetLeft + panel.offsetWidth / 2),
              lengths: panels.map((panel) => panel.offsetWidth),
              panel: panels[0]?.offsetWidth ?? 0,
              view: pin.clientWidth / zoom,
              rem: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
              pad: ruler.current ? (ruler.current.getBoundingClientRect().left - pinLeft) / zoom : 0
            }
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(pin)
    observer.observe(el)
    return () => observer.disconnect()
  }, [track, ruler, vertical])
  return geo
}

// "From product to production" as one horizontal track at every width, pinned for 4.5 screens, read like a camera
// that only ever frames one thing: Product → "Starting" → Vinaya → "Proposing" → the next Product. Each gap is wider
// than the room beside a centred panel, so a panel always stands alone on screen, and between panels the camera
// follows the line's tip as it draws until it meets the next panel. The intro sits above the pin. Scroll order:
//   0.00–0.10 the first Product, alone: its steps light (Deciding, its chip, Defining and the docs)
//   0.12–0.30 "Starting" draws out of it and the camera follows the tip to Vinaya; Vinaya's frame lights on arrival
//   0.30–0.58 Vinaya, alone: its four steps light one by one
//   0.62–0.80 only then "Proposing" draws and the camera follows it to the next Product
//   0.80–0.95 the next Product, alone: Deciding, its chip, then Defining and its three docs
// Scrolling back reverses it all. On a phone the same track runs down the screen: the panels stack, the pipes run down
// and the fabric lies across them, and the camera moves down. The block is fitted to the pin's height across; under
// reduced motion the panels stack, finished, joined by their labels.
function TwoWorlds({ logoUrl }: { logoUrl: string | null }) {
  const ref = useRef<HTMLElement>(null)
  const reduced = useReducedMotion()
  const block = useRef<HTMLDivElement>(null)
  const track = useRef<HTMLDivElement>(null)
  const ruler = useRef<HTMLDivElement>(null)
  const startingLine = useRef<CrossingHandle>(null)
  const proposingLine = useRef<CrossingHandle>(null)
  const vertical = useVerticalTrack()
  useFitToPin(block, !reduced && !vertical)
  const geo = useTrackGeometry(track, ruler, vertical)
  // The panels' own steps re-render, but only while a panel is alone on screen: their values never change while the
  // camera moves between panels.
  const [panels, setPanels] = useState({ first: 0, vinayaLit: false, vinaya: 0, next: 0 })

  // Every frame of scroll, without a React render: the camera (the track's position), the two lines' energy and labels.
  const frame = useCallback(
    (p: number) => {
      const starting = easeInOutQuad(progressBetween(p, 0.12, 0.3))
      const proposing = easeInOutQuad(progressBetween(p, 0.62, 0.8))
      // The camera: centred on a panel while it plays, and between panels moving with the line's tip, which runs from
      // the panel's edge to the next one's as the line draws, so the camera reaches the next panel as the line does.
      const [c0 = 0, c1 = 0, c2 = 0] = geo.centers
      const shift = geo.view / 2 - (c0 + (c1 - c0) * starting + (c2 - c1) * proposing)
      if (track.current) track.current.style.transform = vertical ? `translateY(${shift}px)` : `translateX(${shift}px)`
      startingLine.current?.setDraw(starting)
      proposingLine.current?.setDraw(proposing)
      const next = {
        first: progressBetween(p, 0, 0.1),
        vinayaLit: starting >= 1,
        vinaya: progressBetween(p, 0.3, 0.58),
        next: progressBetween(p, 0.8, 0.95)
      }
      setPanels((previous) =>
        previous.first === next.first &&
        previous.vinayaLit === next.vinayaLit &&
        previous.vinaya === next.vinaya &&
        previous.next === next.next
          ? previous
          : next
      )
    },
    [geo, vertical]
  )
  usePinnedFrames(ref, frame, !reduced)

  const intro = (
    <div className={cn(WRAP, 'pt-21 sm:pt-37')}>
      <SectionIntro
        className='gap-4'
        eyebrow='How Vinaya does it'
        title='From product to production'
        line='Product decides what to build. Vinaya takes it from there, in four stages, every one written down in the Log.'
      />
    </div>
  )

  if (reduced) {
    const join = (label: string) => (
      <div aria-hidden='true' className='flex items-center gap-3 py-3 text-lg'>
        <ArrowDown className='size-5' strokeWidth={1.75} />
        {label}
      </div>
    )
    return (
      <section className='bg-background text-foreground'>
        {intro}
        <div className={cn(WRAP, 'flex max-w-2xl flex-col pt-12 pb-21 sm:pb-37')}>
          <ProductPanel release='first' />
          {join('Starting')}
          <VinayaPanel lit logoUrl={logoUrl} />
          {join('Proposing')}
          <ProductPanel release='next' />
        </div>
      </section>
    )
  }

  // A gap leaves at least a margin of empty screen beside a centred panel, so its neighbours stay out of frame, and
  // is never shorter than half a panel, so its label has room. Down a phone, panels differ in height: the gap is
  // most of a screen, so the next panel stays below until the line reaches it.
  // Each fabric wall is a fixed object on the track, standing on the seam between two screens: with the panel before it
  // centred the seam is the screen's far side, with the panel after it centred the near side. The lines meet the wall
  // exactly there, and only the wall past the seam, on Vinaya's side, is drawn, so it slides in as soon as the track
  // moves and stands whole against the Vinaya screen's border. A gap is the room left beside the two panels on one
  // screen. It never fades: it scrolls with the track. (On a phone a panel can fill the screen; the gap keeps a minimum.)
  const [l0 = 0, l1 = 0, l2 = 0] = geo.lengths
  const seam = (before: number, after: number) => {
    // Down a phone the panels fill the screen, so the gap is most of a screen with the wall in its middle.
    if (vertical) return { length: geo.view * 0.6, wall: 0.5 }
    const length = Math.max(geo.view * (vertical ? 0.4 : 0.25), geo.view - (before + after) / 2)
    return { length, wall: Math.min(1, Math.max(0, (geo.view / 2 - before / 2) / length)) }
  }
  const startingGap = seam(l0, l1)
  const proposingGap = seam(l1, l2)

  return (
    <section ref={ref} className='relative bg-background text-foreground'>
      {intro}
      <div className='relative h-[450vh]'>
        <div className='sticky top-0 flex h-[calc(100dvh-3.5rem)] items-center overflow-hidden'>
          <div aria-hidden='true' className={cn(WRAP, 'pointer-events-none absolute inset-x-0 top-0')}>
            <div ref={ruler} />
          </div>
          <div ref={block} className={vertical ? 'absolute inset-x-0 top-0' : 'w-full'}>
            <div
              ref={track}
              className={vertical ? cn(WRAP, 'relative flex flex-col') : 'relative flex w-max items-stretch'}
            >
              <div data-panel='' className={cn(!vertical && PANEL_W, 'flex flex-col')}>
                <ProductPanel release='first' progress={panels.first} />
              </div>
              <EnergyCrossing
                ref={startingLine}
                label='Starting'
                length={startingGap.length}
                wall={startingGap.wall}
                into
                vertical={vertical}
                className={vertical ? undefined : GAP_W}
              />
              <div data-panel='' className={cn(!vertical && PANEL_W, 'flex flex-col')}>
                <VinayaPanel lit={panels.vinayaLit} progress={panels.vinaya} logoUrl={logoUrl} />
              </div>
              <EnergyCrossing
                ref={proposingLine}
                label='Proposing'
                length={proposingGap.length}
                wall={proposingGap.wall}
                into={false}
                vertical={vertical}
                className={vertical ? undefined : GAP_W}
              />
              <div data-panel='' className={cn(!vertical && PANEL_W, 'flex flex-col')}>
                <ProductPanel release='next' progress={panels.next} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function Stage({
  n,
  tone,
  name,
  line,
  steps,
  reverse = false,
  background
}: {
  n: number
  tone: Tone
  name: string
  line: string
  steps: readonly ProcessStep[]
  reverse?: boolean
  background: string
}) {
  const ref = useRef<HTMLElement>(null)
  // As Home's Gates, flowing: the line fills and the steps light as the section comes up the screen.
  const progress = useEnterProgress(ref, 0.7, 0.6)
  return (
    <section ref={ref} className={cn(background, 'text-foreground', SECTION_Y)}>
      <div
        className={cn(
          WRAP,
          'grid items-center gap-y-7 lg:gap-x-25',
          reverse ? 'lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]' : 'lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]'
        )}
      >
        <div className={cn('flex flex-col gap-6', reverse && 'lg:order-last')}>
          <span className={cn('text-8xl font-extralight leading-none tracking-tighter sm:text-9xl', toneText[tone])}>
            {n}
          </span>
          <Heading level={2} weight='normal' variant='headline'>
            {name}
          </Heading>
          <Text variant='lead' tone='muted'>
            {line}
          </Text>
        </div>
        <ProcessSteps steps={steps} progress={progress} />
      </div>
    </section>
  )
}

// A thin band after stage 4 that points to the four ways work enters, played as the interactive demo.
function DiscoverFlows() {
  return (
    <section className='bg-accent py-20 text-accent-foreground'>
      <div className={cn(WRAP, 'flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between')}>
        <Heading level={2} weight='normal' variant='title'>
          Discover more about the Vinaya development process flows
        </Heading>
        <ButtonLink href='/vinaya-process/demo' className='w-full shrink-0 sm:w-auto'>
          <Play aria-hidden />
          Play the interactive demo
        </ButtonLink>
      </div>
    </section>
  )
}

// Gates: the three rings as steps, the way the stages draw theirs, beside the counts.
/**
 * A figure that counts up from 0 once `start` turns true, after `delay` ms: fast at first, slowing to a gentle stop
 * (ease-out over 1.4s), in tabular figures so its width holds. On its final value it turns ring and stays. Plays once
 * per page view; under reduced motion the final value shows at once, in ring.
 */
function CountUp({ value, start, delay }: { value: number; start: boolean; delay: number }) {
  const reduced = useReducedMotion()
  const [shown, setShown] = useState(0)
  useEffect(() => {
    if (!start) return
    if (reduced) {
      setShown(value)
      return
    }
    let frame = 0
    const from = performance.now() + delay
    const tick = (now: number) => {
      const t = Math.max(0, Math.min(1, (now - from) / 1400))
      setShown(Math.round(value * (1 - (1 - t) ** 3)))
      if (t < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [start, reduced, value, delay])
  const done = shown === value
  return (
    <span
      className={cn(
        'tabular-nums transition-colors duration-250 motion-reduce:transition-none',
        done ? 'text-ring' : toneText[TONE.exec]
      )}
    >
      {shown}
    </span>
  )
}

function Gates() {
  const ref = useRef<HTMLElement>(null)
  const progress = useEnterProgress(ref, 0.7, 0.6)
  const figures = useRef<HTMLDListElement>(null)
  const counting = useSeen(figures)
  return (
    <section ref={ref} id='gates' className={cn('scroll-mt-14 bg-background text-foreground', SECTION_Y)}>
      <div className={cn(WRAP, 'grid items-center gap-y-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-x-25')}>
        <div className='flex flex-col gap-8'>
          <SectionIntro
            eyebrow='Gates'
            title='Every stage is gated'
            line='Checks that refuse unsafe work, from your machine to the merge and after it. No agent can skip them.'
          />
          <dl ref={figures} className='m-0 grid gap-5 border-t border-border/50 pt-6'>
            {GATE_FIGURES.map(([figure, what], i) => (
              <div key={figure} className='grid grid-cols-[4.5rem_minmax(0,1fr)] items-baseline gap-x-4'>
                <dt className='text-4xl font-extralight leading-none tracking-tighter'>
                  <CountUp value={Number(figure)} start={counting} delay={i * 150} />
                </dt>
                <dd className='m-0 text-lg leading-normal text-muted-foreground'>{what}</dd>
              </div>
            ))}
          </dl>
          <ButtonLink href='/docs/process/gates' variant='outline' size='xl' className={ACTION}>
            See all 37 checks
            <ArrowRight aria-hidden />
          </ButtonLink>
        </div>
        <ProcessSteps steps={GATE_STEPS} progress={progress} />
      </div>
    </section>
  )
}

function Roles() {
  return (
    <section className='bg-secondary py-21 text-foreground sm:py-35.5'>
      <div className={cn(WRAP, 'flex flex-col gap-16')}>
        <SectionIntro
          eyebrow='Roles'
          title='Who does what'
          line='Agents do the work, each with only the tools its role needs. A person holds the decisions.'
          className='max-w-4xl'
        />
        <ul className='m-0 list-none border-t border-border/50 p-0'>
          {ROLES.map(([role, stage, does, who]) => (
            <li
              key={role}
              className='grid grid-cols-[minmax(0,1fr)] gap-y-2 border-b border-border/50 py-6 sm:grid-cols-[minmax(0,4fr)_minmax(0,7fr)_11rem] sm:items-baseline sm:gap-x-8'
            >
              <span className='flex flex-col gap-1'>
                <span className='text-3xl leading-snug tracking-tight'>{role}</span>
                <Text as='span' variant='eyebrow' tone='muted'>
                  {stage}
                </Text>
              </span>
              <span className='text-lg leading-normal text-muted-foreground'>{does}</span>
              <Text as='span' variant='eyebrow' tone='muted' className='sm:text-right'>
                {who}
              </Text>
            </li>
          ))}
        </ul>
        <Principal />
      </div>
    </section>
  )
}

function Principal() {
  return (
    <div className='flex flex-col gap-16 pt-8'>
      <SectionIntro
        eyebrow='The Principal'
        title='Five decisions stay with a person'
        line='Any engineer can hold the seat. Every decision is written to the Log under their name.'
        className='max-w-4xl'
      />
      <ul className='m-0 list-none border-t border-border/50 p-0'>
        {DECISIONS.map(([what, when]) => (
          <li
            key={what}
            className='grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-5 gap-y-2 border-b border-border/50 py-6 sm:grid-cols-[auto_minmax(0,1fr)_auto]'
          >
            <span aria-hidden='true' className='w-7 text-2xl leading-snug text-ring sm:w-14'>
              ☞
            </span>
            <span className='text-3xl leading-snug tracking-tight'>{what}</span>
            <span className='col-start-2 text-lg leading-normal text-muted-foreground sm:col-start-auto'>{when}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Cta() {
  return (
    <section className='bg-primary py-30 text-primary-foreground'>
      <div className={cn(WRAP, 'flex flex-col items-center gap-6 text-center')}>
        <Heading level={2} weight='normal' variant='headline'>
          Run it on your own repository
        </Heading>
        <Text variant='lead' className='opacity-75'>
          Set up once. The process is ready in your agent when you finish.
        </Text>
        <div className='flex w-full flex-wrap justify-center gap-3.5 pt-2'>
          <ButtonLink href='/start' variant='secondary' size='xl' className={ACTION}>
            Get started
          </ButtonLink>
          <ButtonLink href='/docs/process' variant='inverse-outline' size='xl' className={ACTION}>
            Read the docs
          </ButtonLink>
        </div>
      </div>
    </section>
  )
}

export function ProcessLanding({ logoUrl }: { logoUrl: string | null }) {
  return (
    <main>
      <Hero />
      <ShipAllDay />
      <TwoWorlds logoUrl={logoUrl} />
      <Stage
        n={1}
        tone={TONE.think}
        name='Thinking'
        line='The Architect sets the milestone and its tranches. A Planner reads the real specs and the real code and writes each task as an Issue.'
        steps={STAGE_ONE}
        background='bg-secondary'
      />
      <Stage
        n={2}
        tone={TONE.exec}
        name='Executing'
        line='Each task runs in a loop: a Developer builds, fresh Reviewers check, every gate runs. A blocked task pauses for a ruling.'
        steps={STAGE_TWO}
        reverse
        background='bg-background'
      />
      <StudioBridge />
      <Stage
        n={3}
        tone={TONE.retro}
        name='Retrospecting'
        line='On every merge the work is closed and archived: each task, then its tranche, then the milestone.'
        steps={STAGE_THREE}
        background='bg-background'
      />
      <Stage
        n={4}
        tone={TONE.hot}
        name='Self-improvement'
        line='Built into the harness: the Log becomes a report, the Improver reads it and proposes projects. The Principal approves them, and they go back to product.'
        steps={STAGE_FOUR}
        reverse
        background='bg-secondary'
      />
      <DiscoverFlows />
      <Gates />
      <Roles />
      <Cta />
    </main>
  )
}
