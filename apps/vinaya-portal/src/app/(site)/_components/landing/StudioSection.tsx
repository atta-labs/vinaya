'use client'

import { useLayoutEffect, useRef, useState } from 'react'
import { cn } from '@/ui/lib/utils'
import { LoopMonitor, type LoopScript } from './LoopMonitor'

const STEPS = [
  { title: 'See where the project stands', detail: 'Every milestone, how far along it is' },
  { title: 'Follow every task', detail: 'Dispatched, in flight, merged, in order' },
  { title: 'Monitor the dev–review loop', detail: 'Every round, every verdict, live' }
] as const

export type StudioMilestone = { name: string; facts: string; target: number }
export type StudioTask = { id: string; title: string }

const MILESTONES: readonly StudioMilestone[] = [
  { name: 'checkout-v2', facts: '3 tranches · 1 active · 14 tasks', target: 64 },
  { name: 'log-portable-v1', facts: '2 tranches · 1 active · 9 tasks', target: 40 },
  { name: 'vada-production-v1', facts: '4 tranches · 0 active · 18 tasks', target: 50 }
] as const

const TASKS: readonly StudioTask[] = [
  { id: '#889', title: 'Event schema versioning' },
  { id: '#891', title: 'Synchronous exit write' },
  { id: '#893', title: 'Custom events' },
  { id: '#895', title: 'Streaming parser' },
  { id: '#897', title: 'Custom events CLI' }
] as const

const MONO_LABEL = 'font-mono text-xs uppercase tracking-widest text-muted-foreground'
// Side padding is the window header's (1.1rem), so everything inside the window lines up with it.
const PANEL_PAD = 'px-[1.1rem] py-[clamp(0.9rem,2.5vh,1.4rem)]'

function panelState(stage: number, index: number) {
  return cn(
    'absolute inset-0 transition-[opacity,transform] duration-[400ms] motion-reduce:transition-none',
    stage === index
      ? 'translate-y-0 opacity-100'
      : cn('pointer-events-none opacity-0', stage > index ? '-translate-y-[14px]' : 'translate-y-[14px]')
  )
}

export const STUDIO_STEPS = STEPS

/**
 * The Studio window. Everything on it derives from four numbers, so a caller can drive it by scroll (this
 * section) or by a timer (Home's Studio tile): the view on show, how far the milestone bars have filled, how
 * far the tasks have run, and how many loop events have happened.
 */
export function StudioMock({
  stage,
  milestoneFill,
  taskFill,
  lines,
  narrow,
  bodyClassName,
  milestones = MILESTONES,
  tasks = TASKS,
  loop,
  maxLogRows,
  fit = false
}: {
  stage: number
  milestoneFill: number
  taskFill: number
  lines: number
  narrow: boolean
  /** The height of the views area under the window's bar. */
  bodyClassName: string
  /** What the window lists; a taller window passes more so it stays full. */
  milestones?: readonly StudioMilestone[]
  tasks?: readonly StudioTask[]
  /** A longer loop for the monitor, and how many log rows it may grow to. */
  loop?: LoopScript
  maxLogRows?: 7 | 8 | 9 | 10 | 11 | 12
  /**
   * The window's height follows its content instead of filling its parent: the milestones view and the tasks view
   * are measured, and the views area takes the one on show (the loop monitor, which fits any height, takes the
   * taller of the two), easing 300ms between them. Never taller than the parent allows.
   */
  fit?: boolean
}) {
  const milestonesRef = useRef<HTMLDivElement>(null)
  const tasksRef = useRef<HTMLDivElement>(null)
  const natural = useNaturalHeights(fit, milestonesRef, tasksRef)
  const bodyHeight =
    !fit || !natural ? undefined : stage === 0 ? natural[0] : stage === 1 ? natural[1] : Math.max(...natural)
  return (
    <div
      className={cn(
        'flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-lg',
        fit ? 'max-h-full' : 'flex-1'
      )}
    >
      <div className='flex items-center gap-4 border-b border-border px-[1.1rem] py-3 font-mono text-sm'>
        <span className='whitespace-nowrap font-semibold tracking-widest max-[820px]:tracking-widest'>
          VINAYA STUDIO
        </span>
        <span className='flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground'>
          atta-labs/attalabs · main
        </span>
        <span className='inline-flex items-center gap-[0.4rem] whitespace-nowrap text-muted-foreground'>
          <i className='inline-block size-[7px] rounded-full bg-success' />
          live · 11:06
        </span>
      </div>
      <div
        className={cn(
          'relative',
          fit ? 'min-h-0 shrink transition-[height] duration-300 ease-out motion-reduce:transition-none' : 'flex-1',
          bodyClassName
        )}
        style={bodyHeight === undefined ? undefined : { height: bodyHeight }}
      >
        <div
          ref={milestonesRef}
          aria-hidden={stage !== 0}
          className={cn(panelState(stage, 0), PANEL_PAD, 'flex flex-col gap-[clamp(0.4rem,1.4vh,0.8rem)]')}
        >
          <span className={MONO_LABEL}>milestones</span>
          {milestones.map((milestone) => (
            <div
              key={milestone.name}
              className='flex min-h-0 flex-col justify-center gap-[clamp(0.15rem,0.6vh,0.35rem)] overflow-hidden rounded-lg border border-border bg-background px-[0.95rem] py-[clamp(0.35rem,1.2vh,0.65rem)]'
            >
              <div className='flex items-baseline justify-between gap-4'>
                <span className='text-lg'>{milestone.name}</span>
                <span className='font-mono text-xs text-muted-foreground'>milestone</span>
              </div>
              <span className='font-mono text-sm text-muted-foreground'>{milestone.facts}</span>
              <div className='h-[6px] overflow-hidden rounded-sm bg-border'>
                <div
                  className='h-full bg-success transition-[width] duration-500 ease-out motion-reduce:transition-none'
                  style={{ width: `${(milestone.target * milestoneFill).toFixed(1)}%` }}
                />
              </div>
            </div>
          ))}
        </div>

        <div
          ref={tasksRef}
          aria-hidden={stage !== 1}
          className={cn(
            panelState(stage, 1),
            'flex flex-col pt-[clamp(0.9rem,2.5vh,1.4rem)]',
            fit && 'pb-[clamp(0.9rem,2.5vh,1.4rem)]'
          )}
        >
          <div className='flex items-baseline justify-between gap-4 px-[clamp(0.9rem,2.5vh,1.4rem)] pb-[clamp(0.5rem,1.4vh,0.8rem)]'>
            <span className={MONO_LABEL}>tranche · log-portable-v1</span>
            <span className='font-mono text-xs uppercase tracking-widest text-success'>active</span>
          </div>
          <div className='grid grid-cols-[3.5rem_minmax(0,1fr)_auto] items-center gap-3 border-t border-border bg-secondary px-[clamp(0.9rem,2.5vh,1.4rem)] py-[0.45rem] font-mono text-xs uppercase tracking-widest text-muted-foreground'>
            <span>#</span>
            <span>task</span>
            <span>status</span>
          </div>
          {tasks.map((task, index) => {
            // The last task waits in the queue; the rest go out one after another across the fill.
            const a = index * (0.85 / tasks.length)
            const b = a + 0.2
            const state =
              index === tasks.length - 1
                ? 'queued'
                : taskFill >= b
                  ? 'merged'
                  : taskFill >= a
                    ? 'in flight'
                    : 'dispatched'
            return (
              <div
                key={task.id}
                className='grid grid-cols-[3.5rem_minmax(0,1fr)_auto] items-center gap-3 border-t border-border px-[clamp(0.9rem,2.5vh,1.4rem)] py-[clamp(0.4rem,1.2vh,0.6rem)] text-lg'
              >
                <span className='font-mono text-sm text-muted-foreground'>{task.id}</span>
                <span className='overflow-hidden text-ellipsis whitespace-nowrap'>{task.title}</span>
                <span
                  className={cn(
                    'justify-self-end rounded-full border border-current px-2 py-[0.15rem] font-mono text-xs transition-colors duration-300 motion-reduce:transition-none',
                    state === 'merged'
                      ? 'text-success'
                      : state === 'in flight'
                        ? 'text-foreground'
                        : 'text-muted-foreground'
                  )}
                >
                  {state}
                </span>
              </div>
            )
          })}
        </div>

        <div aria-hidden={stage !== 2} className={cn(panelState(stage, 2), PANEL_PAD, narrow && 'py-2', '@container')}>
          <LoopMonitor k={lines} loop={loop} maxRows={maxLogRows} />
        </div>
      </div>
    </div>
  )
}

/**
 * The content height of the milestones and the tasks views: the panel's padding, its rows at their full size (a
 * milestone card squeezed by a short screen still reports its full content through scrollHeight) and the gaps
 * between them. The panels are absolute, so their own height says nothing; their rows do. Re-measured on any resize
 * (width, font, theme).
 */
function useNaturalHeights(on: boolean, ...panels: React.RefObject<HTMLDivElement | null>[]): [number, number] | null {
  const [heights, setHeights] = useState<[number, number] | null>(null)
  useLayoutEffect(() => {
    if (!on) return
    const els = panels.map((r) => r.current)
    if (els.some((el) => !el)) return
    const measure = () => {
      const next = els.map((el) => {
        const node = el as HTMLDivElement
        const style = getComputedStyle(node)
        const rows = [...node.children] as HTMLElement[]
        const gap = Number.parseFloat(style.rowGap) || 0
        const pad = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0)
        const content = rows.reduce((sum, row) => sum + Math.max(row.offsetHeight, row.scrollHeight), 0)
        return Math.ceil(pad + content + gap * Math.max(0, rows.length - 1))
      }) as [number, number]
      setHeights((prev) => (prev && prev[0] === next[0] && prev[1] === next[1] ? prev : next))
    }
    measure()
    const ro = new ResizeObserver(measure)
    for (const el of els) {
      ro.observe(el as Element)
      for (const child of (el as Element).children) ro.observe(child)
    }
    return () => ro.disconnect()
  }, [on])
  return heights
}
