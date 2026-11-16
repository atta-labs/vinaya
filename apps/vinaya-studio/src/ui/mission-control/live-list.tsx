'use client'

import {
  Badge,
  type BadgeProps,
  Button,
  Card,
  Heading,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Text
} from '@vinaya/ui'
import type { MissionControlState, RepositoryState } from '@/lib/mission-control-connection'
import { TASK_STATE_NAMES, type TaskStateName, type TaskView } from '@/lib/mission-control-protocol'
import { type UseMissionControlOptions, useMissionControl } from '@/lib/use-mission-control'

/**
 * Mission Control's minimal live task list. It shows what the server projected and never works a task's state out
 * itself: the state label, the amber flag and the line of what is happening all arrive on the task. The page only
 * orders rows by the state's rank, shows ages against its own clock, and says honestly how much it knows.
 */

export type BoardStatusKind =
  | 'connecting'
  | 'catching-up'
  | 'live'
  | 'disconnected'
  | 'source-limited'
  | 'credential-failure'
  | 'empty'

export type BoardStatus = { kind: BoardStatusKind; label: string; detail: string }

const STATE_LABELS: Record<TaskStateName, string> = {
  needs_you: 'Needs you',
  presumed_dead: 'Presumed dead',
  stopped_itself: 'Stopped itself',
  needs_a_look: 'Needs a look',
  running: 'Running',
  ready_to_merge: 'Ready to merge'
}

const STATE_VARIANTS: Record<TaskStateName, BadgeProps['variant']> = {
  needs_you: 'default',
  presumed_dead: 'destructive',
  stopped_itself: 'secondary',
  needs_a_look: 'outline',
  running: 'label',
  ready_to_merge: 'outline'
}

const COLUMNS = ['Repository', 'Task', 'State', 'Now', 'Who', 'Pull request', 'Last sign'] as const

/** The upstream says its credential was refused or missing. The protocol carries the source's own words, not a code. */
const CREDENTIAL_WORDS = /credential|unauthori[sz]ed|forbidden|\b40[13]\b/i

type RepositoryStanding = BoardStatusKind

function repositoryName(repo: RepositoryState): string {
  return repo.remote ?? repo.id
}

function standingOf(repo: RepositoryState): RepositoryStanding {
  const { status } = repo
  switch (status.connection) {
    case 'unavailable':
      return CREDENTIAL_WORDS.test(status.reason ?? '') ? 'credential-failure' : 'disconnected'
    case 'reconnecting':
    case 'stopped':
      return 'disconnected'
    case 'opening':
    case 'catching-up':
      return 'catching-up'
    case 'live':
      if (!repo.coverage.complete || !status.live) return 'source-limited'
      return Object.keys(repo.tasks).length === 0 ? 'empty' : 'live'
  }
}

/** Worst first: what the reader most needs to know wins the page's one headline. */
const PRECEDENCE: BoardStatusKind[] = [
  'credential-failure',
  'disconnected',
  'catching-up',
  'source-limited',
  'empty',
  'live'
]

function describe(kind: BoardStatusKind, repos: RepositoryState[]): BoardStatus {
  const reasons = repos
    .filter((r) => standingOf(r) === kind)
    .map((r) => r.status.reason ?? r.coverage.limits[0]?.detail ?? null)
    .filter((r): r is string => r !== null)
  const why = reasons[0] ? ` ${reasons[0]}` : ''
  switch (kind) {
    case 'connecting':
      return { kind, label: 'Connecting', detail: 'Opening the connection to Studio.' }
    case 'catching-up':
      return { kind, label: 'Catching up', detail: 'Reading the Log; the list below is not complete yet.' }
    case 'live':
      return { kind, label: 'Live', detail: 'Following the Log.' }
    case 'disconnected':
      return { kind, label: 'Disconnected', detail: `The picture below may be out of date.${why}` }
    case 'source-limited':
      return { kind, label: 'Source-limited', detail: `Live, but the Log source cannot vouch for everything.${why}` }
    case 'credential-failure':
      return { kind, label: 'Credential refused', detail: `The Log refused the read credential.${why}` }
    case 'empty':
      return { kind, label: 'Live, no tasks', detail: 'The Log was read in full and holds no tasks.' }
  }
}

/** What the page knows about the whole connection, from the browser's link and each repository's own status. */
export function boardStatus(state: MissionControlState): BoardStatus {
  const repos = Object.values(state.repositories)
  if (state.phase === 'disposed' || state.phase === 'reconnecting' || state.phase === 'failed') {
    const detail =
      state.phase === 'failed'
        ? 'Studio stopped reconnecting; the picture below is the last one received.'
        : 'Reconnecting to Studio; the picture below is the last one received.'
    return { kind: 'disconnected', label: 'Disconnected', detail }
  }
  if (state.phase === 'connecting') return describe('connecting', repos)
  // An open socket proves the browser reached Studio, never that the Log is live.
  if (repos.length === 0)
    return { kind: 'catching-up', label: 'Catching up', detail: 'Studio has not reported a repository yet.' }
  const standings = repos.map(standingOf)
  const worst = PRECEDENCE.find((kind) => standings.includes(kind)) ?? 'live'
  return describe(worst, repos)
}

/** How long ago, against the page's clock. A sign that was never recorded reads as unknown, not as zero. */
export function ageText(now: number, lastSign: number): string {
  if (!Number.isFinite(lastSign) || lastSign <= 0) return 'unknown'
  const seconds = Math.max(0, Math.floor((now - lastSign) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

type Row = { repository: RepositoryState; task: TaskView }

/** The server's order: by state rank, then by task number; repositories keep their launch order within that. */
function orderedRows(state: MissionControlState): Row[] {
  const rows: Row[] = []
  for (const repository of Object.values(state.repositories)) {
    for (const task of Object.values(repository.tasks)) rows.push({ repository, task })
  }
  const rank = (name: TaskStateName) => TASK_STATE_NAMES.indexOf(name)
  return rows.sort(
    (a, b) =>
      rank(a.task.state) - rank(b.task.state) ||
      a.repository.id.localeCompare(b.repository.id, undefined, { numeric: true }) ||
      a.task.task - b.task.task
  )
}

function emptyText(status: BoardStatus): string {
  switch (status.kind) {
    case 'empty':
      return 'No tasks in this Log.'
    case 'connecting':
      return 'Connecting; no tasks received yet.'
    case 'catching-up':
      return 'Catching up; no tasks received yet.'
    case 'disconnected':
      return 'Disconnected; no tasks received.'
    case 'credential-failure':
      return 'The Log refused the read credential; no tasks received.'
    case 'source-limited':
      return 'No tasks received, and the Log source cannot vouch that there are none.'
    case 'live':
      return 'No tasks received.'
  }
}

export type LiveListProps = {
  state: MissionControlState
  /** The page's local clock, for ages. */
  now: number
  onRetry?: () => void
}

/** The presentational list: the projected picture in, rows out. */
export function LiveList({ state, now, onRetry }: LiveListProps) {
  const status = boardStatus(state)
  const repos = Object.values(state.repositories)
  const rows = orderedRows(state)
  const names = repos.map(repositoryName)
  return (
    <section className='flex flex-col gap-6' data-board-status={status.kind}>
      <header className='flex flex-wrap items-baseline justify-between gap-4'>
        <Heading level={1} size='2xl'>
          Mission Control
        </Heading>
        <div className='flex gap-6'>
          <div className='flex gap-2'>
            <Text as='span' size='sm' tone='muted'>
              Repository
            </Text>
            <Text as='span' size='sm' family='mono' data-board-field='repository'>
              {names.length === 0 ? 'unknown' : names.join(', ')}
            </Text>
          </div>
          <div className='flex gap-2'>
            <Text as='span' size='sm' tone='muted'>
              Branch
            </Text>
            <Text as='span' size='sm' family='mono' data-board-field='branch'>
              unknown
            </Text>
          </div>
        </div>
      </header>
      <Card variant='flat' aria-label='Connection' data-board-part='status' className='flex flex-col gap-2 px-4 py-3'>
        <div className='flex flex-wrap items-center gap-3'>
          <Badge size='xs' variant='outline' data-board-badge={status.kind}>
            {status.label}
          </Badge>
          <Text as='span' size='sm' tone='muted' data-board-detail>
            {status.detail}
          </Text>
          {state.phase === 'failed' && onRetry ? (
            <Button size='sm' variant='outline' onClick={onRetry}>
              Reconnect
            </Button>
          ) : null}
        </div>
        {repos.map((repo) => {
          const standing = standingOf(repo)
          const limits = repo.coverage.limits.map((l) => l.detail)
          return (
            <Text key={repo.id} as='p' size='sm' tone='muted' data-repository-status={repo.id} data-standing={standing}>
              {repositoryName(repo)}: {describe(standing, [repo]).label.toLowerCase()}
              {limits.length > 0 ? ` (${limits.join('; ')})` : ''}
            </Text>
          )
        })}
      </Card>
      <Card variant='flat' data-board-part='list'>
        <Table aria-label='Tasks'>
          <TableHeader>
            <TableRow>
              {COLUMNS.map((column) => (
                <TableHead key={column}>{column}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={COLUMNS.length}>
                  <Text size='sm' tone='muted' data-board-empty={status.kind}>
                    {emptyText(status)}
                  </Text>
                </TableCell>
              </TableRow>
            ) : (
              rows.map(({ repository, task }) => (
                <TableRow
                  key={`${repository.id}:${task.task}`}
                  data-task-row=''
                  data-repository={repository.id}
                  data-task={task.task}
                  data-state={task.state}
                >
                  <TableCell>
                    <Text as='span' size='sm' family='mono'>
                      {repositoryName(repository)}
                    </Text>
                  </TableCell>
                  <TableCell>
                    <Text as='span' size='sm' data-cell='task'>
                      #{task.task} {task.title ?? 'Title not recorded'}
                    </Text>
                  </TableCell>
                  <TableCell>
                    <Badge size='xs' variant={STATE_VARIANTS[task.state]} data-cell='state'>
                      {STATE_LABELS[task.state]}
                    </Badge>
                    {task.amber ? (
                      <Text as='span' size='xs' tone='muted' data-cell='quiet'>
                        {' '}
                        quiet
                      </Text>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <Text as='span' size='sm' data-cell='now'>
                      {task.nowLine || 'unknown'}
                    </Text>
                  </TableCell>
                  <TableCell>
                    <Text as='span' size='sm' family='mono' data-cell='who'>
                      {task.whoActs || 'unknown'} / {task.model ?? 'model unknown'}
                    </Text>
                  </TableCell>
                  <TableCell>
                    <Text as='span' size='sm' family='mono' data-cell='pr'>
                      {task.pr === null ? 'unknown' : `#${task.pr}`}
                    </Text>
                  </TableCell>
                  <TableCell>
                    <Text as='span' size='sm' tone='muted' data-cell='last-sign'>
                      {ageText(now, task.lastSign)}
                    </Text>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>
    </section>
  )
}

/** The connected list: the page's one subscription to the live route. */
export function MissionControlLiveList(options: UseMissionControlOptions) {
  const { state, now, retry } = useMissionControl(options)
  return <LiveList state={state} now={now} onRetry={retry} />
}
