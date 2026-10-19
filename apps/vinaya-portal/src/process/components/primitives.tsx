'use client'

import { type ComponentProps, type ReactNode, useLayoutEffect, useRef } from 'react'
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@/ui/components'
import { cn } from '@/ui/lib/utils'
import { Text } from '@/ui/shared'
import { toneBorder, toneText, toneTint } from '../tone'
import type { Tone } from '../types'

/** Uppercase mono label. `tone` colours it; without one it is muted. `size` raises it to a headline (`lg`, `xl`). */
export function Eyebrow({
  tone,
  size = 'xs',
  className,
  children,
  ...props
}: ComponentProps<'span'> & { tone?: Tone; size?: 'xs' | 'lg' | 'xl' }) {
  return (
    <Text
      as='span'
      variant='eyebrow'
      size={size}
      weight={size === 'xs' ? undefined : 'semibold'}
      tone={tone ? undefined : 'muted'}
      className={cn(tone && toneText[tone], className)}
      {...props}
    >
      {children}
    </Text>
  )
}

/** Small mono pill on the library Badge. `lit` colours it with the tone. */
export function Pill({
  tone,
  lit,
  className,
  children
}: {
  tone?: Tone
  lit?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <Badge variant='code' className={cn(lit && tone && [toneBorder[tone], toneText[tone]], className)}>
      {children}
    </Badge>
  )
}

/** A tinted callout on the library Card: one bold line and a sentence. */
export function Banner({ tone, title, children }: { tone: Tone; title: string; children?: ReactNode }) {
  return (
    <Card className={cn(toneBorder[tone], toneTint[tone])}>
      <CardHeader className='pb-1'>
        <CardTitle size='md'>{title}</CardTitle>
      </CardHeader>
      {children && (
        <CardContent>
          <Text size='sm' tone='muted'>
            {children}
          </Text>
        </CardContent>
      )}
    </Card>
  )
}

/** Figures in a row, one Card each. Only for the self-improvement stage. */
export function StatTiles({ stats }: { stats: { value: string; label: string }[] }) {
  return (
    <div className='grid grid-cols-3 gap-2'>
      {stats.map((s) => (
        <Card key={s.label}>
          <CardHeader className='pb-0'>
            <CardTitle size='xl' className='tabular-nums'>
              {s.value}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Eyebrow>{s.label}</Eyebrow>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

/**
 * Fills its box, and shrinks its content to fit when the content would
 * overflow: the content is laid out at a larger box and scaled down, so it
 * keeps its own layout and never spills. At sizes where it fits, nothing
 * changes. A pinned step uses it, so a short window shows the whole step.
 */
export function ShrinkToFit({ children, className }: { children: ReactNode; className?: string }) {
  const box = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const b = box.current
    const el = inner.current
    if (!b || !el) return
    const fit = () => {
      const w = b.clientWidth
      const h = b.clientHeight
      if (!w || !h) return
      // Each pass lays the content out at the box the last scale implies; wider text wraps less,
      // so a couple of passes settle on the largest scale at which everything fits.
      let s = 1
      for (let i = 0; i < 4; i++) {
        el.style.width = `${w / s}px`
        el.style.height = `${h / s}px`
        const next = Math.min(1, h / Math.max(h, el.scrollHeight))
        if (Math.abs(next - s) < 0.005) break
        s = next
      }
      el.style.width = `${w / s}px`
      el.style.height = `${h / s}px`
      el.style.transform = s < 1 ? `scale(${s})` : ''
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(b)
    return () => ro.disconnect()
  }, [])
  return (
    <div ref={box} className={cn('relative min-h-0 overflow-hidden', className)}>
      <div ref={inner} className='origin-top-left'>
        {children}
      </div>
    </div>
  )
}
