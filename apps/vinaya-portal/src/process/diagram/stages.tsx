'use client'

import type { ReactNode } from 'react'
import { cn } from '@/ui/lib/utils'
import type { Stage } from '../types'
import { DiagramCard, DiagramContainer } from './DiagramCard'
import { Linked } from './links'
import { type Moment, type NodeState, nodeState, shows, stageState } from './moment'
import { bands, type DiagramNode, nodes } from './nodes'

/**
 * The diagram's chunks. One component per stage; each takes the moment and
 * renders its cards with one shared state, so a stage reads as one thing:
 * everything in it lights together, mutes together, is covered together.
 * `ProcessDiagram` composes them; `/system/diagram-elements` shows them alone.
 */
export type StageProps = { moment: Moment; onNode?: (n: DiagramNode) => void }

/** Whether any of these nodes is drawn at this moment: a row or column with none is left out whole. */
const anyShown = (ids: string[], m: Moment) => ids.some((id) => shows(nodes[id] as DiagramNode, m))

/** A row of cards: the whole diagram's fixed columns, or, when only one flow's part is drawn, equal columns for
 * whatever cards remain, so the row closes up instead of leaving holes. */
const row = (m: Moment, columns: string) => (m.only ? 'grid-flow-col auto-cols-fr' : columns)

const Card = ({
  id,
  moment,
  onNode,
  className,
  children
}: StageProps & { id: string; className?: string; children?: ReactNode }) => {
  const n = nodes[id] as DiagramNode
  if (!shows(n, moment)) return null
  return (
    <DiagramCard node={n} state={nodeState(n, moment)} onClick={onNode} className={className}>
      {children}
    </DiagramCard>
  )
}

/** The frame of a stage: band on top, a tone-coloured rule that lights when the stage is current. */
function StageGroup({
  band,
  at,
  moment,
  nested = false,
  className,
  children
}: {
  band: keyof typeof bands
  at: Stage | 'always'
  moment: Moment
  /** A section inside another stage's container: the same tone, its border at reduced opacity until it is current. */
  nested?: boolean
  className?: string
  children: ReactNode
}) {
  const b = bands[band]
  const state: NodeState = at === 'always' ? 'always' : stageState(at, moment)
  // A still picture shows every stage in its own colour; the walk lights only the stage it is at.
  const toned = state === 'now' || moment.settled === true || moment.allFlows === true
  return (
    <Linked id={band}>
      <DiagramContainer
        title={b.label}
        tone={b.tone}
        lit={toned}
        soft={nested}
        muted={state === 'future'}
        data-node={band}
        data-stage={band}
        data-state={state}
        className={className}
      >
        {children}
      </DiagramContainer>
    </Linked>
  )
}

/** Where the need comes from: Linear, Jira, or the engineer. The diagram's upstream stage and the walk's first section both render this. */
function UpstreamCards(p: StageProps & { className?: string }) {
  return (
    <div className={cn('grid gap-3', row(p.moment, 'grid-cols-12'), p.className)}>
      <Card id='linear' moment={p.moment} onNode={p.onNode} className={p.moment.only ? undefined : 'col-span-4'} />
      <Card id='jira' moment={p.moment} onNode={p.onNode} className={p.moment.only ? undefined : 'col-span-5'} />
      <Card id='need' moment={p.moment} onNode={p.onNode} className={p.moment.only ? undefined : 'col-span-3'} />
    </div>
  )
}

export function StageUpstream(p: StageProps) {
  return (
    <StageGroup band='product' at='upstream' moment={p.moment} className='border-dashed'>
      <UpstreamCards {...p} />
    </StageGroup>
  )
}

export function StageThinking(p: StageProps) {
  // The whole diagram keeps its fixed columns (the Architect sits over the tranche Planner, the
  // planned bar under the three Planners). One flow's part draws fewer cards: each row then
  // centres its cards at half width, so a lone Architect and Planner sit in the middle, stacked.
  const only = p.moment.only === true
  const rowCls = only ? 'flex justify-center gap-3' : 'grid grid-cols-12 gap-3'
  const cardCls = only ? 'w-[calc((100%-0.75rem)/2)]' : 'col-span-3'
  return (
    <StageGroup band='stage1' at='planner' moment={p.moment} className='gap-8'>
      {anyShown(['architect'], p.moment) && (
        <div className={rowCls}>
          <Card id='architect' {...p} className={cardCls} />
        </div>
      )}
      <div className={rowCls}>
        <Card id='planner-tranche' {...p} className={cardCls} />
        <Card id='planner-standalone' {...p} className={cardCls} />
        <Card id='planner-backlog' {...p} className={cardCls} />
        <Card id='hot-issue' {...p} className={cardCls} />
      </div>
      {anyShown(['planned-bar'], p.moment) && (
        <div className='grid grid-cols-12 gap-3'>
          <Card id='planned-bar' {...p} className={only ? 'col-span-12' : 'col-span-9'} />
        </div>
      )}
    </StageGroup>
  )
}

/** The loop with its driver, Developer and Reviewers: one card, reused wherever the loop is drawn. */
export function DevReviewLoop(p: StageProps & { className?: string }) {
  return (
    <Card id='loop' {...p} className={p.className}>
      <div className='mt-1 grid gap-6'>
        <Card id='driver' {...p} />
        <div className='grid grid-cols-2 gap-2'>
          <Card id='developer' {...p} />
          <Card id='reviewers' {...p} />
        </div>
      </div>
    </Card>
  )
}

/** The Engine and the four runtimes under the loop. */
export function Runtime(p: StageProps) {
  return (
    <div className='@container grid gap-2'>
      {/* four across when the stage is wide enough for the titles, two otherwise: a container query, not a viewport one */}
      <div className='grid grid-cols-2 gap-2 @3xl:grid-cols-4'>
        <Card id='rt-claude' {...p} />
        <Card id='rt-codex' {...p} />
        <Card id='rt-mac' {...p} />
        <Card id='rt-linux' {...p} />
      </div>
    </div>
  )
}

export function StageExecuting(p: StageProps) {
  return (
    <StageGroup band='stage2' at='loop' moment={p.moment}>
      {/* the loop and hot mode are the two ways to execute: equal halves */}
      <div className={cn('grid gap-3', row(p.moment, 'grid-cols-2'))}>
        {anyShown(['loop', 'engine'], p.moment) && (
          <div className='grid content-start gap-2'>
            <DevReviewLoop {...p} />
            <Card id='engine' {...p} />
          </div>
        )}
        <Card id='hot-mode' {...p} />
      </div>
      {/* the runtimes serve the loop and hot mode alike: full width under both */}
      <Runtime {...p} />
      {/* Everything after the work is part of executing, and automatic: the gates, closure, the record. */}
      <div className='mt-6 grid gap-10'>
        <StageGates {...p} />
        <StageClosure {...p} />
        <StageRetrospecting {...p} />
      </div>
    </StageGroup>
  )
}

export function StageGates(p: StageProps) {
  return (
    <StageGroup band='gates' nested at='loop' moment={p.moment}>
      <div className={cn('grid gap-3', row(p.moment, 'grid-cols-3'))}>
        <Card id='ring0' {...p} />
        <Card id='ring1' {...p} />
        <Card id='ring2' {...p} />
      </div>
    </StageGroup>
  )
}

export function StageClosure(p: StageProps) {
  return (
    <StageGroup band='closure' nested at='merge' moment={p.moment}>
      <div className={cn('grid gap-3', row(p.moment, 'grid-cols-3'))}>
        <Card id='replan' {...p} />
        <Card id='recover' {...p} />
        <Card id='merge' {...p} />
      </div>
    </StageGroup>
  )
}

export function StageRetrospecting(p: StageProps) {
  return (
    <StageGroup band='stage3' nested at='archive' moment={p.moment}>
      <div className={cn('grid gap-3', row(p.moment, 'grid-cols-4'))}>
        <Card id='archivist' {...p} />
        <Card id='tranche-archivist' {...p} />
        <Card id='milestone-close' {...p} />
        <Card id='record' {...p} />
      </div>
    </StageGroup>
  )
}

/** Self-improvement's two cards: the report and the Improver's proposals. Stage 4 of the diagram; the other flows' last step renders it too. */
export function ImproverCards(p: StageProps & { className?: string }) {
  return (
    <div className={cn('grid grid-cols-2 gap-3', p.className)}>
      <Card id='stats' moment={p.moment} onNode={p.onNode} />
      <Card id='improver' moment={p.moment} onNode={p.onNode} />
    </div>
  )
}

export function StageImprovement(p: StageProps) {
  return (
    <StageGroup band='stage4' at='improve' moment={p.moment}>
      <ImproverCards {...p} />
    </StageGroup>
  )
}

/** The right column: the Log and Studio, always on, sharing the height. */
/** The Log and Studio, alive at the moment. `row` puts the two side by side (the process page's right column); default stacks them (the diagram's column). */
export function Observability(p: StageProps & { className?: string; row?: boolean }) {
  return (
    <DiagramContainer
      as='aside'
      title={bands.observe.label}
      tone='log'
      dashed
      className={cn('flex min-h-0 min-w-0 flex-col rounded-l-none border-foreground/60', p.className)}
    >
      <div className={cn('flex min-h-0 flex-1 gap-3', p.row ? 'flex-row' : 'flex-col')}>
        <Card id='log' moment={p.moment} onNode={p.onNode} className='min-h-0 min-w-0 flex-1' />
        <Card id='studio' moment={p.moment} onNode={p.onNode} className='min-h-0 min-w-0 flex-1' />
      </div>
    </DiagramContainer>
  )
}
