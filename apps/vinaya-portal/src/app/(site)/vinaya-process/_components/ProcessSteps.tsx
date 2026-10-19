import type { ReactNode } from 'react'
import { toneBg } from '@/process/tone'
import type { Tone } from '@/process/types'
import { clamp01 } from '@/ui/lib/math'
import { cn } from '@/ui/lib/utils'

// Home's Gates vocabulary at the boards' large size: a circle, a line down to the next one, a title, a grey line
// and an outlined mono chip. With `progress` it moves the way Home's Gates does: the line fills, and each step
// lights as the fill reaches it (circle filled, words up, chip in). Without it every step is drawn lit and still.

/**
 * `fill` a foreground circle (✓ once lit) · `ring` a person's decision (☞ in the ring colour) · `tone` the stage's
 * own colour with its number · `dash` outside Vinaya, a dashed circle in the ring colour.
 */
type StepCircle = 'fill' | 'ring' | 'tone' | 'dash' | 'lit'
type StepChip = 'line' | 'ring' | 'ok' | 'term' | 'dash' | 'bare'

export type ProcessStep = {
  title: string
  /** The grey line under the title; leave it out for a title alone. */
  line?: string
  circle?: StepCircle
  /** What a `tone` or `dash` circle shows. */
  mark?: ReactNode
  chip?: ReactNode
  chipStyle?: StepChip
  /** A step that belongs to its own stage (the Vinaya panel's four) sets its tone here. */
  tone?: Tone
}

const CHIP: Record<StepChip, string> = {
  line: 'border-foreground',
  ring: 'border-ring',
  ok: 'border-success text-success',
  term: 'border-foreground bg-foreground text-background',
  dash: 'border-dashed border-ring',
  // No frame: the chip's content draws its own boxes.
  bare: 'border-0 p-0 sm:p-0 font-sans'
}

function circleFace(circle: StepCircle, lit: boolean, index: number, mark: ReactNode, tone: Tone = 'log') {
  if (circle === 'tone')
    return {
      className: lit
        ? cn(toneBg[tone], 'text-background')
        : 'border-2 border-border bg-background text-muted-foreground',
      face: mark ?? index + 1
    }
  // Lit on scroll: a half-transparent ring once reached, dimmed before.
  if (circle === 'lit')
    return {
      className: lit ? 'bg-ring/50 text-foreground' : 'border-2 border-border bg-background text-muted-foreground',
      face: mark ?? index + 1
    }
  if (circle === 'dash')
    return {
      className: cn('border-2 border-dashed border-ring bg-background text-ring', !lit && 'opacity-35'),
      face: mark
    }
  // Not reached yet: dimmed, so only what the reader has reached reads in full ink.
  if (!lit) return { className: 'border-2 border-border bg-background text-muted-foreground', face: index + 1 }
  return circle === 'ring'
    ? { className: 'bg-ring text-primary-foreground', face: '☞' }
    : { className: 'bg-foreground text-background', face: '✓' }
}

// The boards' two sizes: `large` for a stage's own section, `compact` for the two panels that share one screen.
const SIZE = {
  large: {
    row: 'gap-x-4 sm:gap-x-6',
    circle: 'size-11.5 text-base sm:size-16 sm:text-2xl',
    gap: 'pb-7 sm:pb-10',
    title: 'pt-3 text-xl sm:pt-4 sm:text-3xl',
    line: 'mt-1 text-base sm:text-xl',
    chip: 'mt-3.5 px-3 py-3 text-sm sm:px-5 sm:py-3 sm:text-lg'
  },
  compact: {
    row: 'gap-x-4',
    circle: 'size-10 text-base',
    // Every step but the last takes the same height, whatever it holds (a grey line or a chip), so two panels set
    // side by side keep one rhythm from circle to circle.
    gap: 'min-h-27 pb-4',
    title: 'pt-2 text-xl',
    line: 'mt-0.5 text-base',
    chip: 'mt-2.5 px-3 py-2 text-sm'
  }
} as const

export function ProcessSteps({
  steps,
  progress,
  size = 'large'
}: {
  steps: readonly ProcessStep[]
  progress?: number
  size?: keyof typeof SIZE
}) {
  const sz = SIZE[size]
  const moving = progress !== undefined
  const fill = moving ? clamp01((progress - 0.06) / 0.8) : 1
  const gaps = Math.max(1, steps.length - 1)
  return (
    <ol className='m-0 flex list-none flex-col p-0'>
      {steps.map((step, index) => {
        const last = index === steps.length - 1
        const lit = !moving || (progress >= 0.06 && fill >= index / gaps - 0.001)
        const next = moving ? clamp01(gaps * fill - index) : 1
        const { className, face } = circleFace(step.circle ?? 'fill', lit, index, step.mark, step.tone)
        return (
          <li key={step.title} className={cn('grid grid-cols-[auto_minmax(0,1fr)]', sz.row)}>
            <div aria-hidden='true' className='flex flex-col items-center'>
              <span
                className={cn(
                  'box-border grid shrink-0 place-items-center rounded-full transition duration-300 motion-reduce:transition-none',
                  sz.circle,
                  className
                )}
              >
                {face}
              </span>
              {last ? null : (
                <span className={cn('relative w-0.5 flex-1', moving ? 'bg-border/50' : 'bg-foreground')}>
                  {moving ? (
                    <span
                      className={cn('absolute inset-x-0 top-0', step.circle === 'lit' ? 'bg-ring/50' : 'bg-foreground')}
                      style={{ height: `${next * 100}%` }}
                    />
                  ) : null}
                </span>
              )}
            </div>
            <div
              className={cn(
                'flex min-w-0 flex-col transition-opacity duration-400 motion-reduce:transition-none',
                !last && sz.gap,
                lit ? 'opacity-100' : 'opacity-35'
              )}
            >
              <span className={cn('leading-tight tracking-tight', sz.title)}>{step.title}</span>
              {step.line ? (
                <span className={cn('leading-normal text-muted-foreground', sz.line)}>{step.line}</span>
              ) : last || step.chip ? null : (
                // A title alone keeps the line's slot, so its steps fall on the same rhythm as a panel beside it.
                <span aria-hidden='true' className={cn('invisible leading-normal', sz.line)}>
                  ·
                </span>
              )}
              {step.chip ? (
                <span
                  className={cn(
                    'flex flex-wrap gap-x-3 gap-y-1 border-2 font-mono leading-snug transition duration-400 motion-reduce:transition-none',
                    sz.chip,
                    CHIP[step.chipStyle ?? 'line'],
                    lit ? 'translate-x-0 opacity-100' : '-translate-x-2 opacity-0'
                  )}
                >
                  {step.chip}
                </span>
              ) : null}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
