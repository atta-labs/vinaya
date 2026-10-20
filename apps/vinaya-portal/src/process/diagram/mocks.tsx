import { useEffect, useRef } from 'react'
import { Badge } from '@/ui/components'
import { cn } from '@/ui/lib/utils'
import { Text } from '@/ui/shared'
import { BrandIcon } from '../components/BrandIcon'
import { ChatWindow } from '../components/ChatWindow'
import { useEnvironment } from '../environment-context'
import { improveConclusions, improveProposals, improveStats, timeSplit } from '../fixtures/lifecycle'
import { hotChat } from '../flows/hot/scripts'
import { toneBg, toneBorder, toneText } from '../tone'
import { defaultEnvironment, logServerLabel } from '../types'
import { useMoment } from './links'
import { eventsAt, rowsAt } from './live'
import type { Moment } from './moment'
import type { DiagramTone, DiagramMock as Mock } from './nodes'

/** The small illustrations inside diagram cards. Each is a component; each takes only data. */

export function TaskList({
  label,
  tag,
  items,
  tone = 'think'
}: {
  label: string
  tag: string
  items: string[]
  tone?: DiagramTone
}) {
  return (
    <div className='mt-1.5 grid gap-1 rounded-sm border border-border bg-background p-2 font-mono text-[10px]'>
      <div className='flex justify-between'>
        <span className='text-foreground'>{label}</span>
        <span className={toneText[tone]}>{tag}</span>
      </div>
      {items.map((it) => (
        <div key={it} className='flex items-center gap-2'>
          <span className='w-9 shrink-0 text-muted-foreground'>{it}</span>
          <span className='h-1 flex-1 rounded-full bg-border' />
        </div>
      ))}
    </div>
  )
}

export function IssueChip({
  n,
  tag,
  title,
  tone = 'think'
}: {
  n: string
  tag: string
  title: string
  tone?: DiagramTone
}) {
  return (
    <div className='mt-1.5 grid gap-1 rounded-sm border border-border bg-background p-2'>
      <div className='flex items-center justify-between gap-2'>
        <span className='flex items-center gap-2 font-mono text-[11px] text-foreground'>
          <i className={cn('size-2.5 rounded-full border', toneBorder[tone])} />
          {n}
        </span>
        <Badge variant='code' size='2xs' className={cn(toneBorder[tone], toneText[tone])}>
          {tag}
        </Badge>
      </div>
      <Text as='span' size='xs' tone='foreground' className='truncate'>
        {title}
      </Text>
      <span className='font-mono text-[10px] text-muted-foreground'>opened · no tranche</span>
    </div>
  )
}

/** Hot mode is a person and one agent in the agent's own app: the real ChatWindow, three lines. */
export function MiniChat() {
  return (
    <div className='mt-1.5 min-w-0'>
      <ChatWindow
        surface='claude'
        lines={hotChat('claude').slice(1, 4)}
        env={{ ...defaultEnvironment, os: 'mac', agent: 'claude', mode: 'chat' }}
        tone='hot'
      />
    </div>
  )
}

/** The Log at the moment: the last events the flow has written. Static sample outside a diagram frame. */
export function EventList({ fill }: { fill?: boolean } = {}) {
  const moment = useMoment()
  const env = useEnvironment()
  const sample: [string, string, DiagramTone][] = [
    ['plan.task_created', 'tranche/3', 'log'],
    ['loop.round_started', 'round 2', 'log'],
    ['gate.result', 'green', 'log'],
    ['review.verdict', 'approve', 'log'],
    ['hot.commit', 'pushed', 'hot'],
    ['archive.task_closed', 'merged', 'retro']
  ]
  const live = moment ? eventsAt(finished(moment)) : null
  const rows: [string, string, DiagramTone][] = live
    ? live.slice(-4).map((e) => [e.name, e.detail, (e.tone ?? 'log') as DiagramTone])
    : sample
  const total = live?.length ?? 42
  // The newest event stays in view when the box is shorter than its rows.
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = box.current
    if (el) el.scrollTop = el.scrollHeight
  }, [total])
  return (
    <div
      ref={box}
      className={cn(
        'mt-1.5 grid gap-1 rounded-sm border border-border bg-background p-2 font-mono text-[10px]',
        fill && 'min-h-0 flex-1 overflow-y-auto',
        fill && (stillAt(moment) ? 'content-start' : 'content-evenly')
      )}
    >
      <div className='flex justify-between text-muted-foreground'>
        <span>THE LOG · LIVE</span>
        <span>{total} events</span>
      </div>
      {rows.length === 0 && <span className='text-muted-foreground'>nothing recorded yet</span>}
      {rows.map(([name, detail, tone], i) => (
        <span key={`${i}-${name}`} className='grid grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] gap-2'>
          <span className={cn('truncate', toneText[tone])}>{name}</span>
          <span className='truncate text-muted-foreground'>{detail}</span>
        </span>
      ))}
      <div className='mt-1 flex items-center gap-3 border-t border-border pt-2 text-muted-foreground'>
        {env ? (
          <>
            <BrandIcon brand={env.logServer} className='size-3.5' />
            <span>shipped to {logServerLabel[env.logServer]}</span>
          </>
        ) : (
          <>
            <span>any log server</span>
            <BrandIcon brand='cloudflare' className='size-3.5' />
            <BrandIcon brand='grafana' className='size-3.5' />
            <BrandIcon brand='datadog' className='size-3.5' />
            <BrandIcon brand='github' className='size-3.5' />
          </>
        )}
      </div>
    </div>
  )
}

/** How many loops a still picture lists before it counts the rest. */
const STILL_ROWS = 6

/** A still picture, not a moment in the walk. */
const stillAt = (m: Moment | null | undefined) => m?.settled === true || m?.allFlows === true

/** A still picture shows the run finished (the whole Log, every loop done); a moment in the walk shows itself. */
const finished = (m: Moment): Moment => (m.settled || m.allFlows ? { ...m, stage: 'improve' } : m)

/** Mission Control at the moment: the flow's tasks and their state. Static sample outside a diagram frame. */
export function LoopBars({ fill }: { fill?: boolean } = {}) {
  const moment = useMoment()
  const sample: [string, string, [number, number, DiagramTone][]][] = [
    ['loop 1', 'done', [[0, 100, 'retro']]],
    ['loop 2', 'running', [[0, 55, 'exec']]],
    ['loop 3', 'queued', []],
    ['hot', 'hot', [[0, 70, 'hot']]]
  ]
  const all = moment
    ? rowsAt(finished(moment)).map((r) => [r.label, r.state, r.segments] as (typeof sample)[number])
    : sample
  // A still picture shows the first few loops and counts the rest; the walk shows every one.
  const still = stillAt(moment)
  const bars = still ? all.slice(0, STILL_ROWS) : all
  const more = all.length - bars.length
  return (
    <div
      className={cn(
        'mt-1.5 grid gap-1.5 rounded-sm border border-border bg-background p-2 font-mono text-[9px]',
        fill && 'min-h-0 flex-1 overflow-y-auto',
        fill && (stillAt(moment) ? 'content-start' : 'content-evenly')
      )}
    >
      <div className='flex justify-between text-muted-foreground'>
        <span>EXECUTION, LIVE</span>
        <span className='text-destructive'>now</span>
      </div>
      {bars.map(([label, state, segs]) => (
        <div key={label} className='flex items-center gap-2'>
          <span className='w-10 shrink-0 text-muted-foreground'>{label}</span>
          <div className='relative h-2 flex-1 rounded-full bg-border'>
            {segs.map(([l, w, tone]) => (
              <span
                key={`${label}-${l}`}
                className={cn('absolute inset-y-0 rounded-full', toneBg[tone], state === 'running' && 'site-blink')}
                style={{ left: `${l}%`, width: `${w}%` }}
              />
            ))}
          </div>
          <span className='w-12 shrink-0 truncate text-right text-muted-foreground'>{state}</span>
        </div>
      ))}
      {more > 0 && <span className='text-muted-foreground'>+ {more} more loops</span>}
      <span className='text-muted-foreground'>develop · review · ruling · done</span>
    </div>
  )
}

export function StatRow() {
  return (
    <div className='mt-1.5 grid gap-2'>
      <div className='grid grid-cols-3 gap-2'>
        {improveStats.slice(0, 3).map(({ value, label, hot }) => (
          <div key={label} className='rounded-sm border border-border bg-background p-2'>
            <span
              className={cn(
                'block text-lg font-semibold tabular-nums leading-6',
                hot ? 'text-destructive' : 'text-foreground'
              )}
            >
              {value}
            </span>
            <span className='block truncate font-mono text-[9px] uppercase text-muted-foreground'>{label}</span>
          </div>
        ))}
      </div>
      <span className='font-mono text-[9px] text-muted-foreground'>WHERE THE TIME GOES</span>
      <div className='flex h-2 overflow-hidden rounded-full'>
        <span className='w-[84%] bg-chart-3' />
        <span className='w-[16%] bg-chart-4' />
      </div>
      <Text as='span' size='xs' tone='muted' className='truncate'>
        {timeSplit.map((s) => `${s.label} ${s.share}%`).join(' · ')} ·{' '}
        {improveConclusions.map((c) => c[0]?.toLowerCase() + c.slice(1)).join(' · ')}
      </Text>
    </div>
  )
}

export function ProposalList() {
  return (
    <div className='mt-1.5 grid gap-1.5'>
      {improveProposals.map((p) => (
        <div key={p.title} className='grid rounded-sm border border-border bg-background px-2 py-1.5'>
          <Text as='span' size='xs' weight='semibold' tone='foreground' className='truncate'>
            Project: {p.title[0]?.toLowerCase() + p.title.slice(1)}
          </Text>
          <span className='truncate text-[10px] text-muted-foreground'>
            {p.kind} · {p.text}
          </span>
        </div>
      ))}
    </div>
  )
}

export function DiagramMock({ mock, tone }: { mock: Mock; tone: DiagramTone }) {
  switch (mock.kind) {
    case 'tasks':
      return <TaskList label={mock.label} tag={mock.tag} items={mock.items} tone={tone} />
    case 'issue':
      return <IssueChip n={mock.n} tag={mock.tag} title={mock.title} tone={tone} />
    case 'chat':
      return <MiniChat />
    case 'events':
      return <EventList fill />
    case 'loops':
      return <LoopBars fill />
    case 'stats':
      return <StatRow />
    case 'proposals':
      return <ProposalList />
  }
}
