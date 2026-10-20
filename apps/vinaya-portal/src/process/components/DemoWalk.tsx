'use client'

import { useRouter } from 'next/navigation'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { PortalBar } from '@/app/(site)/_components/PortalBar'
import { clamp01 } from '@/ui/lib/math'
import { cn } from '@/ui/lib/utils'
import { Text } from '@/ui/shared'
import { MapDialog } from '../diagram/MapDialog'
import { flows } from '../fixtures'
import { flowHref } from '../flows/routes'
import { type Cursor, cursorForStage, diagramStageOf, stepLines } from '../replay'
import { storeEnvironment, useProcess } from '../store'
import type { Stage, Step } from '../types'
import { toneOfStage } from '../types'
import { type Crumb, Crumbs, FlowMenu } from './cards'
import { EnvironmentMenu } from './Environment'
import { ShrinkToFit } from './primitives'
import { StepView } from './StepSection'

/**
 * The header is the site bar (`h-14`) plus the app's toolbar (`h-12`): 6.5rem,
 * whose pixels follow the theme's root font size. Classes use 6.5rem; the scroll
 * code reads the header's real height.
 */
const barHeight = () => document.querySelector('header')?.getBoundingClientRect().height ?? 56
/** Scroll each step takes: enough per line to read it, never less than a screen's worth. */
const runwayOf = (lines: number) => Math.max(640, lines * 40)

const crumbOf = (s: Stage): Crumb =>
  s === 'upstream'
    ? 'upstream'
    : s === 'architect' || s === 'planner'
      ? 'thinking'
      : s === 'loop' || s === 'gates' || s === 'merge'
        ? 'executing'
        : s === 'archive'
          ? 'executing'
          : 'improve'

function useReducedMotion() {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const q = matchMedia('(prefers-reduced-motion: reduce)')
    const on = () => setReduced(q.matches)
    on()
    q.addEventListener('change', on)
    return () => q.removeEventListener('change', on)
  }, [])
  return reduced
}

/**
 * One flow's walk, shared by the four subpages: the site bar and the app's toolbar, then the steps on the left,
 * moved by the reader's scroll, and the flow's own `aside` on the right. Inside a `ProcessProvider` that is started.
 * `edgeToEdge`: the step window and the aside run edge to edge below 1280 (Complex work's scene).
 */
export function DemoWalk({
  logoUrl,
  search,
  aside,
  edgeToEdge = false
}: {
  logoUrl: string | null
  search?: ReactNode
  aside: ReactNode
  edgeToEdge?: boolean
}) {
  const router = useRouter()
  const { state, dispatch, currentStep } = useProcess()
  const flow = flows[state.flow]
  const steps = flow.steps as Step[]
  const reduced = useReducedMotion()
  const refs = useRef<(HTMLDivElement | null)[]>([])
  // the whole process, full screen: opened from the walk's last step, browsed on its own
  const [mapOpen, setMapOpen] = useState(false)
  const [mapFlow, setMapFlow] = useState<typeof state.flow>('feature')
  const [mapAt, setMapAt] = useState<Stage>('improve')
  const setEnv = (env: typeof state.env) => {
    storeEnvironment(env)
    dispatch({ type: 'env', env, chosen: true })
  }
  const { cursor } = state
  /** The walk waits for the stored environment, so it never draws the default first. */
  const ready = state.envKnown

  const runways = useMemo(
    () => steps.map((s) => runwayOf(stepLines(s, state.flow, state.agent).length)),
    [steps, state.flow, state.agent]
  )

  // A new start begins at the top of the page.
  useEffect(() => {
    scrollTo({ top: 0 })
  }, [state.started, state.flow])

  // Back from the diagram, the sections open where the diagram left the walk: the cursor's step, at its progress.
  // Declared before the scroll clock, so the clock's first reading already sees the restored position.
  const scrollToCursor = (c: Cursor) => {
    const el = refs.current[c.step]
    if (!el) return
    const bar = barHeight()
    const top = el.getBoundingClientRect().top + scrollY - bar
    const travel = Math.max(0, el.offsetHeight - (innerHeight - bar))
    last.current = c
    scrollTo({ top: top + c.progress * travel })
  }
  useEffect(() => {
    if (state.started && state.view === 'sections') scrollToCursor(cursor)
  }, [state.view])

  /** The stages this flow has, as crumbs: a backlog or hot Issue has no upstream. */
  const available = useMemo(() => [...new Set(steps.map((s) => crumbOf(s.stage)))], [steps])
  /** A crumb in the top bar picks the stage and scrolls the walk there. */
  const pickCrumb = (c: Crumb) => {
    const thinking = steps.find((x) => x.stage === 'architect' || x.stage === 'planner')?.stage ?? 'architect'
    const stage: Stage =
      c === 'upstream' ? 'upstream' : c === 'thinking' ? thinking : c === 'executing' ? 'loop' : 'improve'
    dispatch({ type: 'stage', stage })
    if (state.view === 'sections') scrollToCursor(cursorForStage(state.flow, stage))
  }

  // The reader's scroll is the only clock: the step pinned under the bar, and how far through its runway they are.
  const last = useRef(cursor)
  useEffect(() => {
    if (!ready || !state.started || state.view !== 'sections') return
    // Measured in the scroll event itself: seven rects per event, no frame to wait for.
    const measure = () => {
      const bar = barHeight()
      const view = innerHeight - bar
      let step = 0
      let progress = 0
      for (let i = 0; i < steps.length; i++) {
        const el = refs.current[i]
        if (!el) continue
        const r = el.getBoundingClientRect()
        if (r.top <= bar + 1) {
          step = i
          progress = clamp01((bar - r.top) / Math.max(1, r.height - view))
        }
      }
      if (reduced) progress = 1
      const prev = last.current
      if (prev.step === step && Math.abs(prev.progress - progress) < 0.001) return
      last.current = { step, progress }
      dispatch({ type: 'cursor', cursor: last.current })
    }
    addEventListener('scroll', measure, { passive: true })
    addEventListener('resize', measure)
    measure()
    return () => {
      removeEventListener('scroll', measure)
      removeEventListener('resize', measure)
    }
  }, [ready, state.started, state.view, steps, reduced, dispatch])

  /** The one stage both views show: the one the diagram picked, or the walk's own. */
  const diagramStage = state.mapStage ?? diagramStageOf(currentStep.stage)

  return (
    <>
      <header className='sticky top-0 z-20 bg-background/90 backdrop-blur'>
        {/* The site's own bar first, so the app sits inside the portal like every other page. */}
        <PortalBar logoUrl={logoUrl} search={search} />
        {/* The app's toolbar: the flow's name and its stages, then the two menus, complexity and environment.
            Complexity moves to the other flow's subpage; the environment is stored, so it comes along. */}
        <div className='flex h-12 items-center gap-2 border-y border-border/40 px-3 lg:gap-4 lg:px-6'>
          <Text as='span' variant='eyebrow' size='xs' tone='foreground' className='shrink-0'>
            {flow.label}
          </Text>
          <div className='hidden min-w-0 overflow-hidden md:flex'>
            <Crumbs
              active={crumbOf(diagramStage)}
              tone={toneOfStage[diagramStage]}
              onPick={pickCrumb}
              only={available}
            />
          </div>
          <div className='ml-auto flex shrink-0 items-center gap-2'>
            <FlowMenu
              flow={state.flow}
              onChange={(f) => {
                if (f !== state.flow) router.push(flowHref(f))
              }}
            />
            {ready && <EnvironmentMenu env={state.env} onChange={setEnv} />}
          </div>
        </div>
      </header>
      <MapDialog
        open={mapOpen}
        onOpenChange={setMapOpen}
        flow={mapFlow}
        stage={mapAt}
        onFlow={setMapFlow}
        onStage={setMapAt}
      />

      {/* The walk takes two fifths, the animation three; on a tablet half each, so the walk's type has room. */}
      {ready && state.started && state.view === 'sections' && (
        <main className='grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]'>
          {/* An edge-to-edge window runs edge to edge below 1280: the step pads its own words there */}
          <div className={cn('min-w-0 xl:pl-10 xl:pr-6', edgeToEdge ? 'max-xl:px-0' : 'px-4 md:pl-6 md:pr-4')}>
            {steps.map((step, i) => (
              <div
                key={`${state.flow}-${i}`}
                ref={(el) => {
                  refs.current[i] = el
                }}
                style={{ height: `calc(100dvh - 6.5rem + ${runways[i]}px)` }}
              >
                <div className='sticky top-26 flex h-[calc(100dvh-6.5rem)] flex-col py-6'>
                  <ShrinkToFit className='h-full'>
                    <StepView
                      className='h-full'
                      step={step}
                      flow={state.flow}
                      env={state.env}
                      progress={i < cursor.step ? 1 : i > cursor.step ? 0 : cursor.progress}
                      onMap={
                        step.outro
                          ? () => {
                              setMapFlow(state.flow)
                              setMapOpen(true)
                            }
                          : undefined
                      }
                    />
                  </ShrinkToFit>
                </div>
              </div>
            ))}
          </div>
          <aside
            className={cn(
              'sticky top-26 hidden h-[calc(100dvh-6.5rem)] min-w-0 flex-col gap-8 self-start md:flex',
              // the animation runs edge to edge; the note keeps its padding
              edgeToEdge ? 'p-0' : 'px-6 py-8 md:pr-10'
            )}
          >
            {aside}
          </aside>
        </main>
      )}
    </>
  )
}
