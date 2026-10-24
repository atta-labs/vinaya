'use client'

import { ArrowUpRight } from 'lucide-react'
import { type ReactNode, useRef } from 'react'
import { easeInOutQuad, progressBetween } from '@/ui/lib/math'
import { NextLink } from '@/ui/lib/next-link'
import { cn } from '@/ui/lib/utils'
import { Heading, Text } from '@/ui/shared'
import { NamedIcon } from '../../_components/icons'
import { HOME_LOOP } from '../../_components/landing/FeatureSections'
import { useEnterProgress, useNarrow, useReducedMotion } from '../../_components/landing/LandingInteractions'
import { StudioMock } from '../../_components/landing/StudioSection'
import { WRAP } from './process-styles'
import { usePinnedProgress } from './use-pinned-progress'

// The bridge between stage 2 and stage 3, one screen that pins for four: the first sentence, Studio and the second
// sentence sit side by side on one horizontal track, joined by a line, and scrolling moves the track through them.
//   before the pin "Log and follow your agents" builds word by word as the section comes up the screen, from its top
//             at half the screen to its top at the bar, so the screen is never empty when it pins
//   0.00–0.06 the line draws out of the sentence
//   0.04–0.22 the track slides left: Studio slides into the middle
//   0.24–0.66 Studio holds and plays Home's four-task script, one event per step of scroll
//   0.70–0.86 the track slides on: the line runs out of Studio and the second sentence slides in, building word
//             by word as it comes (0.76–0.92); then it holds until the pin lets go into stage 3
// Studio is the real StudioMock in its loop-monitor view. Under reduced motion the three stack, finished.

const FIRST = ['Log', 'and', 'follow', 'your', 'agents'] as const
const SECOND = ['And', 'learn', 'from', 'it', 'to', 'self-improve'] as const
const EVENTS = HOME_LOOP.events.length

const SAY = 'text-center font-sans text-4xl leading-none tracking-tighter sm:whitespace-nowrap sm:text-7xl'

function Words({ words, p, from, to }: { words: readonly string[]; p?: number; from: number; to: number }) {
  return words.map((word, i) => {
    const t =
      p === undefined
        ? 1
        : progressBetween(p, from + ((to - from) * i) / words.length, from + ((to - from) * (i + 1)) / words.length)
    return (
      <span
        key={word}
        className='mx-1 inline-block transition duration-200 ease-linear motion-reduce:transition-none sm:mx-2.5'
        style={{ opacity: t, transform: `translateY(${Math.round((1 - t) * 24)}px)` }}
      >
        {word}
      </span>
    )
  })
}

/** A sentence on the track: it sits on the background so the line runs up to it and on from it, never through it. */
function Sentence({ children }: { children: ReactNode }) {
  return (
    <div aria-hidden='true' className={cn(SAY, 'relative bg-secondary px-4 py-6 sm:px-8')}>
      {children}
    </div>
  )
}

function StudioPanel({ events, narrow }: { events: number; narrow: boolean }) {
  return (
    <div className='relative mx-auto flex h-full max-h-154 w-full max-w-5xl flex-col bg-secondary sm:max-h-191'>
      <div className='mb-5 flex shrink-0 flex-wrap items-end justify-between gap-x-7 gap-y-3'>
        <div>
          <Text as='span' variant='eyebrow' tone='muted' className='mb-3 block'>
            Built into the harness
          </Text>
          <span className='flex items-center gap-3.5'>
            <NamedIcon name='Studio' className='size-9 sm:size-12' />
            <Heading level={3} weight='normal' variant='title'>
              Studio
            </Heading>
          </span>
          <Text variant='lead' tone='muted' className='mt-2 hidden sm:block'>
            What your agents are doing, right now, and every step written to the Log
          </Text>
        </div>
        <NextLink
          href='/docs/features/studio'
          variant='unstyled'
          className='inline-flex items-center gap-2 border-b-2 border-foreground pb-1 text-lg font-medium hover:text-muted-foreground'
        >
          Open Studio
          <ArrowUpRight className='size-4' strokeWidth={1.75} aria-hidden />
        </NextLink>
      </div>
      <div aria-hidden='true' className='flex min-h-0 flex-1 flex-col'>
        <StudioMock
          stage={2}
          milestoneFill={1}
          taskFill={1}
          lines={events}
          narrow={narrow}
          bodyClassName='min-h-0'
          loop={HOME_LOOP}
          maxLogRows={12}
        />
      </div>
    </div>
  )
}

export function StudioBridge() {
  const ref = useRef<HTMLElement>(null)
  const reduced = useReducedMotion()
  const narrow = useNarrow()
  const p = usePinnedProgress(ref)
  // The run-up before the pin: 0 with the section's top just below half the screen, 1 a little before it reaches the bar.
  const runUp = useEnterProgress(ref, 0.58, 0.5)

  const title = <h2 className='sr-only'>Log and follow your agents. And learn from it to self-improve.</h2>

  if (reduced) {
    return (
      <section className='bg-secondary text-foreground'>
        <div className={cn(WRAP, 'flex flex-col gap-18 py-21 sm:py-37')}>
          <Sentence>
            <Words words={FIRST} from={0} to={1} />
          </Sentence>
          <div className='h-154 sm:h-191'>
            <StudioPanel events={EVENTS} narrow={narrow} />
          </div>
          <Sentence>
            <Words words={SECOND} from={0} to={1} />
          </Sentence>
        </div>
        {title}
      </section>
    )
  }

  // Where the track stands, in slots: 0 the first sentence, 1 Studio, 2 the second sentence.
  const slot = easeInOutQuad(progressBetween(p, 0.04, 0.22)) + easeInOutQuad(progressBetween(p, 0.7, 0.86))
  const events = Math.round(progressBetween(p, 0.24, 0.66) * EVENTS)
  // The line's tip runs half a screen ahead of the middle, so it leaves the sentence once it has built and reaches
  // the edge of the screen, leading into whatever slides in next.
  const reach = 0.5 * progressBetween(p, 0, 0.06)

  return (
    <section ref={ref} className='relative h-[400vh] bg-secondary text-foreground'>
      <div className='sticky top-0 h-[calc(100dvh-3.5rem)] overflow-hidden'>
        <div className='relative flex h-full' style={{ transform: `translateX(${-slot * 100}%)` }}>
          {/* The line, part of the track: from the first sentence's middle to the second's, drawn to the screen's
              edge, so it runs out of what is leaving and into what is arriving. The panels sit on the background
              and hide it behind them. */}
          <div aria-hidden='true' className='absolute top-1/2 left-1/2 h-0.5 w-[200%] -translate-y-1/2'>
            <div
              className='h-full origin-left bg-foreground'
              style={{ transform: `scaleX(${Math.min(1, (slot + reach) / 2)})` }}
            />
          </div>
          {/* Centred in the pin, the sentence would sit below the fold while the pin is only half on screen: during the
              run-up it is lifted toward the visible half, and settles to the centre as the pin sticks. */}
          <div
            className='flex h-full w-full shrink-0 items-center justify-center px-3.5 sm:px-14'
            style={{ transform: `translateY(${-(1 - runUp) * 30}dvh)` }}
          >
            <Sentence>
              <Words words={FIRST} p={runUp} from={0} to={0.9} />
            </Sentence>
          </div>
          <div className='h-full w-full shrink-0' inert={Math.abs(slot - 1) > 0.5}>
            <div className={cn(WRAP, 'flex h-full items-center py-5')}>
              <StudioPanel events={events} narrow={narrow} />
            </div>
          </div>
          <div className='flex h-full w-full shrink-0 items-center justify-center px-3.5 sm:px-14'>
            <Sentence>
              <Words words={SECOND} p={p} from={0.76} to={0.92} />
            </Sentence>
          </div>
        </div>
      </div>
      {title}
    </section>
  )
}
