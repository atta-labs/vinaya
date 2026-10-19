'use client'

import { useEffect, useState } from 'react'
import { clamp01 } from '@/ui/lib/math'
import {
  ConfigFile,
  HOME_LOOP,
  HOME_MILESTONES,
  HOME_TASKS,
  ImproverProposals,
  LOG_LINES,
  LogTerminal,
  MilestoneReport
} from '../landing/FeatureSections'
import { useNarrow, useReducedMotion } from '../landing/LandingInteractions'
import { LOOP_EVENT_COUNT } from '../landing/LoopMonitor'
import { StudioMock } from '../landing/StudioSection'

// Each feature page's live view: home's own component for that feature, played on a clock instead of by scroll.
// It plays, holds on the finished state, and starts again. Under reduced motion it shows the finished state.

const TICK_MS = 120

/** A tick counter that runs 0..total-1 and wraps; stuck on the last tick under reduced motion. */
function useClock(total: number): number {
  const reduced = useReducedMotion()
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (reduced) return
    const id = window.setInterval(() => setTick((t) => (t + 1) % total), TICK_MS)
    return () => window.clearInterval(id)
  }, [reduced, total])
  return reduced ? total - 1 : tick
}

const HOLD = 40

export function LogLive() {
  const per = 6
  const t = useClock(LOG_LINES.length * per + HOLD)
  return (
    <div aria-hidden='true'>
      <LogTerminal count={Math.min(LOG_LINES.length, Math.floor(t / per) + 1)} />
    </div>
  )
}

export function TelemetryLive() {
  // The report's beats run from 9 s (the line) to 12.4 s (the time bar) on home; here from the start of the clock.
  const t = useClock(Math.round(3600 / TICK_MS) + HOLD)
  const ms = 9000 + t * TICK_MS
  return (
    <div aria-hidden='true'>
      <MilestoneReport at={(beat) => ms >= beat} />
    </div>
  )
}

export function ImproverLive() {
  const play = 24
  const t = useClock(play + HOLD)
  const progress = clamp01(t / play)
  return (
    <div aria-hidden='true'>
      <ImproverProposals on={(from) => progress >= from} />
    </div>
  )
}

export function ConfigLive() {
  const per = 8
  const t = useClock(4 * per + HOLD)
  return (
    <div aria-hidden='true'>
      <ConfigFile filled={Math.min(3, Math.floor(t / per))} />
    </div>
  )
}

const MILESTONES_TICKS = 18
const TASKS_TICKS = 18
const EVENT_TICKS = 7

export function StudioLive() {
  const narrow = useNarrow()
  const events = narrow ? LOOP_EVENT_COUNT : HOME_LOOP.events.length
  const t = useClock(MILESTONES_TICKS + TASKS_TICKS + events * EVENT_TICKS + HOLD)
  const loopTicks = t - MILESTONES_TICKS - TASKS_TICKS
  const stage = t < MILESTONES_TICKS ? 0 : loopTicks < 0 ? 1 : 2
  return (
    <div aria-hidden='true' className='flex h-154 flex-col sm:h-170'>
      <StudioMock
        stage={stage}
        milestoneFill={clamp01(t / (MILESTONES_TICKS * 0.8))}
        taskFill={clamp01((t - MILESTONES_TICKS) / (TASKS_TICKS * 0.8))}
        lines={stage < 2 ? 0 : Math.min(events, Math.floor(loopTicks / EVENT_TICKS) + 1)}
        narrow={narrow}
        bodyClassName='min-h-0'
        milestones={narrow ? undefined : HOME_MILESTONES}
        tasks={narrow ? undefined : HOME_TASKS}
        loop={narrow ? undefined : HOME_LOOP}
        maxLogRows={12}
      />
    </div>
  )
}
