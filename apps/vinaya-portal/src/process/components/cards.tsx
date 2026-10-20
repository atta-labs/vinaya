'use client'

import { ChevronDown, Flame, Layers, Layers2, SquareCheck } from 'lucide-react'
import { Fragment, type ReactNode } from 'react'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Popover,
  PopoverContent,
  PopoverTrigger,
  RadioItem
} from '@/ui/components'
import { cn } from '@/ui/lib/utils'
import { Text } from '@/ui/shared'
import { flows } from '../fixtures'
import { toneBg, toneBorder, toneMarker, toneText } from '../tone'
import type { Flow, FlowKey, GateState, LogEvent, OutputCard as OutputCardData, Tone } from '../types'
import { ChoiceToggles, type Row } from './Environment'
import { Eyebrow } from './primitives'

type TaskStatus = 'queued' | 'running' | 'done'

/** Mono task chips on the library Badge. Status colours the border: queued, running (exec), done (retro). */
export function TaskChips({ tasks, status = {} }: { tasks: { issue: number }[]; status?: Record<number, TaskStatus> }) {
  return (
    <div className='flex flex-wrap gap-1.5'>
      {tasks.map((t) => {
        const s = status[t.issue] ?? 'queued'
        const tone: Tone | undefined = s === 'done' ? 'retro' : s === 'running' ? 'exec' : undefined
        return (
          <Badge
            key={t.issue}
            variant='code'
            data-status={s}
            className={cn(tone && [toneBorder[tone], toneText[tone]])}
          >
            #{t.issue}
          </Badge>
        )
      })}
    </div>
  )
}

/** The card a thinking step produces: a Milestone, a tranche of tasks, or one Issue. */
export function OutputCard({ data, status }: { data: OutputCardData; status?: Record<number, TaskStatus> }) {
  if (data.kind === 'milestone')
    return (
      <Card>
        <CardHeader>
          <Eyebrow>Execution Milestone</Eyebrow>
          <CardTitle size='md' family='mono'>
            {data.name}
          </CardTitle>
          <CardDescription family='mono'>branch {data.branch}</CardDescription>
        </CardHeader>
        <CardContent className='grid gap-2'>
          <Eyebrow>Tranche intents</Eyebrow>
          <div className='flex flex-wrap gap-1.5'>
            {data.intents.map((i) => (
              <Badge key={i} variant='code'>
                {i}
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>
    )
  if (data.kind === 'tranche')
    return (
      <Card>
        <CardHeader>
          <Eyebrow>
            {data.tranche.name ? `Tranche ${data.tranche.name}` : 'Issue'} · {data.tranche.tasks.length} task
            {data.tranche.tasks.length > 1 ? 's' : ''}
          </Eyebrow>
        </CardHeader>
        <CardContent className='grid gap-3'>
          {/* One line per task, so a tranche of any size stays a few lines tall; the Surface is in the tooltip. */}
          <div className='grid grid-cols-[auto_auto_minmax(0,1fr)] gap-x-3 gap-y-1'>
            {data.tranche.tasks.map((t) => (
              <Fragment key={t.issue}>
                <Text as='span' size='xs' family='mono' tone='muted'>
                  {t.n ?? '—'}
                </Text>
                <Text as='span' size='xs' family='mono'>
                  #{t.issue}
                </Text>
                <Text as='span' size='xs' family='mono' className='truncate' title={`${t.title} · ${t.file}`}>
                  {t.title}
                </Text>
              </Fragment>
            ))}
          </div>
          {status && <TaskChips tasks={data.tranche.tasks} status={status} />}
        </CardContent>
      </Card>
    )
  return (
    <Card>
      <CardHeader>
        <Eyebrow tone={data.hot ? 'hot' : undefined}>{data.hot ? 'Hot Issue' : 'Backlog Issue'}</Eyebrow>
        <CardTitle size='md' family='mono'>
          #{data.issue} · {data.title}
        </CardTitle>
        <CardDescription family='mono'>{data.surface}</CardDescription>
      </CardHeader>
    </Card>
  )
}

const ringLabel = ['Ring 0 · hooks', 'Ring 1 · CI', 'Ring 2 · audit']

/** The three enforcement points on the library Badge. Idle, running (blinking exec), green. */
export function GatePills({ gates, className }: { gates: GateState; className?: string }) {
  return (
    <div className={cn('grid gap-1.5', className)}>
      {gates.map((g, i) => {
        const tone: Tone | undefined = g === 2 ? 'retro' : g === 1 ? 'exec' : undefined
        return (
          <Badge
            key={ringLabel[i]}
            variant='code'
            data-state={g}
            className={cn('gap-2', tone && [toneBorder[tone], toneText[tone]])}
          >
            <i className={cn('size-2 rounded-full', tone ? toneBg[tone] : 'bg-border', g === 1 && 'site-blink')} />
            {ringLabel[i]}
          </Badge>
        )
      })}
    </div>
  )
}

/** The Log, live, on the library Card: the last events, newest at the bottom. */
export function LogRail({
  events,
  total,
  max = 8,
  className
}: {
  events: LogEvent[]
  total?: number
  max?: number
  className?: string
}) {
  const shown = events.slice(-max)
  return (
    <Card className={cn('overflow-hidden', className)}>
      <CardHeader className='flex flex-row items-center justify-between space-y-0 pb-2'>
        <Eyebrow>The Log · live</Eyebrow>
        <Eyebrow>{total ?? events.length} events</Eyebrow>
      </CardHeader>
      <CardContent>
        <ol className='grid gap-0.5 font-mono text-xs'>
          {shown.map((e, i) => (
            <li
              key={`${events.length - shown.length + i}-${e.name}`}
              className='site-in grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] gap-2.5'
            >
              <span className={cn('truncate font-medium', toneText[e.tone ?? 'log'])}>{e.name}</span>
              <span className='truncate text-muted-foreground'>{e.detail}</span>
            </li>
          ))}
          {shown.length === 0 && <li className='text-muted-foreground'>nothing recorded yet</li>}
        </ol>
      </CardContent>
    </Card>
  )
}

/** The Improver's proposal on the library Card, with its one action on the library Button. */
export function ProposalCard({
  kind,
  title,
  text,
  target,
  created,
  onCreate
}: {
  kind: string
  title: string
  text: string
  target: 'Linear' | 'Jira'
  created?: boolean
  onCreate?: () => void
}) {
  return (
    <Card className={cn('grid grid-cols-[minmax(0,1fr)_auto] items-center', created && toneBorder.retro)}>
      <CardHeader>
        <Eyebrow>{kind}</Eyebrow>
        <CardTitle size='md'>{title}</CardTitle>
        <CardDescription>{text}</CardDescription>
      </CardHeader>
      <CardContent className='pt-6'>
        <Button variant='outline' size='sm' disabled={created} onClick={onCreate}>
          {created ? 'Created · back to product' : `Create in ${target}`}
        </Button>
      </CardContent>
    </Card>
  )
}

/** One of the four entry choices: a Card picked as a radio inside a `RadioGroup`. Pressed = tone border. */
export function ChoiceCard({ flow, pressed, className }: { flow: Flow; pressed: boolean; className?: string }) {
  return (
    <RadioItem
      value={flow.key}
      render={<Card />}
      className={cn(
        'block cursor-pointer px-4 py-[1.111rem] outline-none transition-[border-color,box-shadow,background-color] duration-150 ease-out hover:bg-accent/50 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 motion-reduce:transition-none md:px-6 md:py-[1.333rem] xl:p-6',
        pressed && 'border-ring inset-ring inset-ring-ring',
        className
      )}
    >
      {/* The flow keeps its tone on its title and its bullet markers only; the selection is the orange ring. */}
      <div className='flex items-center justify-between gap-[0.667rem] md:gap-[0.889rem]'>
        <Eyebrow tone={flow.tone} size='lg' className='leading-6 max-md:text-sm max-md:leading-6'>
          {flow.deploy}
        </Eyebrow>
        <span
          aria-hidden='true'
          className={cn(
            'grid size-[1.111rem] shrink-0 place-items-center rounded-full border-[1.5px] transition-colors duration-150 ease-out motion-reduce:transition-none',
            pressed ? 'border-ring' : 'border-border'
          )}
        >
          {pressed && <span className='size-[0.556rem] rounded-full bg-ring' />}
        </span>
      </div>
      <Text leading='normal' className='mt-[0.444rem] max-xl:mt-[0.333rem]'>
        <Text as='span' weight='semibold'>
          Scope:
        </Text>{' '}
        {flow.scope}
      </Text>
      <ul
        className={cn(
          'mt-[0.667rem] grid list-disc grid-cols-1 gap-y-[0.222rem] pl-[1.222rem] md:mt-[0.778rem] md:grid-cols-[max-content_max-content] md:gap-x-[2.667rem] md:pl-[1.333rem] xl:mt-4 xl:gap-y-[0.333rem]',
          toneMarker[flow.tone]
        )}
      >
        {flow.points.map((p) => (
          <li key={p}>
            <Text as='span' leading='normal'>
              {p}
            </Text>
          </li>
        ))}
      </ul>
    </RadioItem>
  )
}

/** Stage breadcrumbs for the top bar, on the library Badge. */
export type Crumb = 'upstream' | 'thinking' | 'executing' | 'improve'

/** The five stage crumbs. With `onPick` each is a library `Button` that moves the walk there; without, a `Badge`. */
export function Crumbs({
  active,
  tone,
  onPick,
  only
}: {
  active: Crumb
  tone: Tone
  onPick?: (c: Crumb) => void
  /** The stages this flow has; the rest are not shown (a backlog or hot Issue has no upstream). */
  only?: Crumb[]
}) {
  const items: { key: typeof active; label: string }[] = [
    { key: 'upstream', label: 'Upstream' },
    { key: 'thinking', label: 'Thinking' },
    { key: 'executing', label: 'Executing' },
    { key: 'improve', label: 'Improve' }
  ]
  return (
    <div className='flex gap-1.5'>
      {items
        .filter((i) => !only || only.includes(i.key))
        .map((i) =>
          onPick ? (
            <Button
              key={i.key}
              variant='code'
              size='xs'
              hoverScale={1}
              tapScale={1}
              aria-current={i.key === active ? 'step' : undefined}
              onClick={() => onPick(i.key)}
              className={cn(i.key === active && [toneBorder[tone], toneText[tone]])}
            >
              {i.label}
            </Button>
          ) : (
            <Badge key={i.key} variant='code' className={cn(i.key === active && [toneBorder[tone], toneText[tone]])}>
              {i.label}
            </Badge>
          )
        )}
    </div>
  )
}

export { Text }

/** The trigger names the flow in a word or two; the menu lists the full names. */
const flowShort: Record<FlowKey, string> = {
  feature: 'Complex work',
  medium: 'Medium work',
  backlog: 'Simple task',
  hot: 'Hot issue'
}

/** Each complexity's icon in the menu: layers for the bigger pieces of work, one box for a single task, a flame for a fix. */
const flowIcon: Record<FlowKey, ReactNode> = {
  feature: <Layers />,
  medium: <Layers2 />,
  backlog: <SquareCheck />,
  hot: <Flame />
}

/**
 * The top-bar complexity menu, built like the environment menu: a popover with one labelled section, the four
 * choices as the same toggle tiles, the current one pressed. Picking one changes the flow; the menu stays open.
 */
export function FlowMenu({ flow, onChange }: { flow: FlowKey; onChange: (f: FlowKey) => void }) {
  const row: Row = {
    label: 'Complexity',
    choices: (Object.keys(flowShort) as FlowKey[]).map((key) => ({
      key,
      icon: flowIcon[key],
      title: flowShort[key],
      hint: '',
      on: key === flow,
      pick: () => onChange(key)
    }))
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant='outline' size='sm' hoverScale={1} tapScale={1} aria-label={`Complexity: ${flows[flow].label}`}>
          Complexity
          <ChevronDown />
        </Button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-[min(28rem,calc(100vw-2rem))]'>
        <div className='grid gap-1.5'>
          <Eyebrow>{row.label}</Eyebrow>
          <ChoiceToggles row={row} hints={false} />
        </div>
      </PopoverContent>
    </Popover>
  )
}
