'use client'

import { Laptop } from 'lucide-react'
import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '@/ui/lib/utils'
import { Text } from '@/ui/shared'
import { BrandIcon } from '../components/BrandIcon'
import { useEnvironment } from '../environment-context'
import { fillEnv } from '../types'
import { Linked } from './links'
import { DiagramMock } from './mocks'
import type { NodeState } from './moment'
import type { DiagramNode, DiagramTone } from './nodes'

/**
 * One card of the diagram: a `DiagramContainer` in its card style. Its look is
 * its `state`; its colour is its `tone`; its text wraps rather than cutting off,
 * and the tag never wraps.
 */
export function DiagramCard({
  node,
  state = 'done',
  className,
  children,
  onClick
}: {
  node: DiagramNode
  state?: NodeState
  className?: string
  /** Child cards, for a container such as the loop or the runtimes. */
  children?: ReactNode
  onClick?: (n: DiagramNode) => void
}) {
  const env = useEnvironment()
  const covered = state === 'impossible'
  const body = !node.compact && (node.lines?.length || node.mock || children)
  return (
    <Linked id={node.id}>
      <DiagramContainer
        variant='card'
        as='div'
        data-node={node.id}
        data-state={state}
        tone={node.tone}
        title={node.title}
        tag={node.tag}
        icon={
          <>
            {node.icon && <BrandIcon brand={node.icon} className='size-3.5 text-muted-foreground' />}
            {node.lucide === 'laptop' && <Laptop className='size-3.5 shrink-0 text-muted-foreground' aria-hidden />}
          </>
        }
        compact={node.compact}
        lit={!covered}
        dashed={covered || node.dashed}
        faded={covered}
        muted={state === 'future'}
        current={state === 'now'}
        onClick={onClick ? () => onClick(node) : undefined}
        className={className}
      >
        {body && (
          <>
            {node.lines?.map((l, i) => {
              const mono = l.startsWith('#')
              return (
                <Text
                  // biome-ignore lint/suspicious/noArrayIndexKey: a node's lines are fixed copy and may repeat; position is their identity
                  key={`${i}-${l}`}
                  as='span'
                  size='xs'
                  leading='relaxed'
                  family={mono ? 'mono' : undefined}
                  tone='muted'
                  className='break-words'
                >
                  {fillEnv(mono ? l.slice(1) : l, env)}
                </Text>
              )
            })}
            {node.mock && <DiagramMock mock={node.mock} tone={node.tone} />}
            {children}
          </>
        )}
      </DiagramContainer>
    </Linked>
  )
}

/** A stage label: thin rule above, mono label in ink (the frames carry no hue); dimmed with its frame until reached. */
export function DiagramBand({
  label,
  lit,
  className
}: {
  label: string
  tone: DiagramTone
  /** The stage is current: the rule and label in full ink. */
  lit?: boolean
  className?: string
}) {
  return (
    <div
      className={cn('flex items-center gap-3 border-t pt-2', lit ? 'border-foreground' : 'border-border', className)}
    >
      <Text
        as='span'
        variant='eyebrow'
        size='xs'
        tone={lit ? 'foreground' : 'muted'}
        className='min-w-0 transition-colors duration-300 in-data-scroll:group-not-data-active/frame:text-muted-foreground'
      >
        {label}
      </Text>
    </div>
  )
}

/**
 * Every element of the diagram: a coloured frame, an optional title, and what
 * goes inside. Two title styles: `stage` (the default) puts a mono band on top
 * and lays the children out in a grid, for the stages and the Log and Studio
 * column; `card` puts a bold title, icon and tag on top and the children in a
 * padded body, for every card (`DiagramCard`). Border, colour and state follow
 * the same rules in both.
 */
export function DiagramContainer({
  variant = 'stage',
  title,
  tag,
  icon,
  compact = false,
  tone,
  lit = true,
  soft = false,
  dashed = false,
  muted = false,
  faded = false,
  current = false,
  as: As = 'section',
  className,
  children,
  onClick,
  ...rest
}: {
  variant?: 'stage' | 'card'
  /** The label on top; leave it out for an untitled group. */
  title?: string
  /** Card style: a short mono tag at the title's right. */
  tag?: string
  /** Card style: an icon before the title. */
  icon?: ReactNode
  /** Card style: a title-only card, so the title row closes the card. */
  compact?: boolean
  tone: DiagramTone
  /** Border and title in full ink. Off: a neutral frame. */
  lit?: boolean
  /** Unlit but still faintly toned: a section nested inside another stage. */
  soft?: boolean
  dashed?: boolean
  /** Not reached yet. */
  muted?: boolean
  /** Not possible in this flow: barely there. */
  faded?: boolean
  /** Where the walk is now: a heavier ink ring. */
  current?: boolean
  as?: 'section' | 'aside' | 'div'
  className?: string
  children?: ReactNode
  onClick?: () => void
} & Omit<HTMLAttributes<HTMLElement>, 'title' | 'onClick'>) {
  const card = variant === 'card'
  return (
    <As
      {...rest}
      onClick={onClick}
      className={cn(
        // `group/frame`: a frame's own title dims with it while the reader has not reached it.
        'group/frame rounded-md border transition-[opacity,border-color] duration-300',
        card
          ? 'relative flex min-w-0 flex-col gap-0 overflow-hidden bg-card p-0 text-card-foreground'
          : 'grid gap-3 p-3',
        // Frames and their labels are drawn in one ink; the tone stays on the graphics, the Log and Studio and the arrows.
        // On a still diagram that lights on scroll (`data-scroll`), a frame not reached yet is dimmed (border and title)
        // and a frame reached takes the ring at 70%, and keeps it.
        'in-data-scroll:not-data-active:border-border in-data-scroll:data-active:border-ring/70',
        lit ? 'border-foreground' : soft ? 'border-foreground/30' : 'border-border',
        dashed && 'border-dashed',
        muted && (card ? 'opacity-30' : 'opacity-60'),
        faded && 'opacity-25',
        current && 'ring-2 ring-foreground/40',
        onClick && 'cursor-pointer',
        className
      )}
    >
      {card ? (
        <>
          {title && (
            <div
              className={cn(
                'flex flex-row items-center justify-between gap-3 px-3 pt-2.5',
                compact ? 'pb-2.5' : 'pb-1'
              )}
            >
              <span className='flex min-w-0 flex-1 items-center gap-2 text-[13px] font-semibold leading-5 tracking-normal text-card-foreground transition-colors duration-300 in-data-scroll:group-not-data-active/frame:text-muted-foreground'>
                {icon}
                <span className='min-w-0 break-words'>{title}</span>
              </span>
              {tag && (
                <span className='shrink-0 truncate font-mono text-[10px] leading-5 text-muted-foreground'>{tag}</span>
              )}
            </div>
          )}
          {children && <div className='flex min-h-0 min-w-0 flex-1 flex-col gap-0.5 px-3 pt-0 pb-3'>{children}</div>}
        </>
      ) : (
        <>
          {title && <DiagramBand label={title} tone={tone} lit={lit} className='border-t-0 pt-0' />}
          {children}
        </>
      )}
    </As>
  )
}
