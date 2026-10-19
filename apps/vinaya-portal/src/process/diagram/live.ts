import { flows, linesFor } from '../fixtures'
import { execScript } from '../fixtures/scripts'
import type { LogEvent, Stage, Step, Task, Tone } from '../types'
import type { Moment } from './moment'

/**
 * What the Log and Mission Control contain at a moment, derived from the
 * flow's own fixtures: the events its steps have written up to this stage,
 * and its tasks with the state they are in.
 */
const order: Stage[] = ['upstream', 'architect', 'planner', 'loop', 'gates', 'merge', 'archive', 'observed', 'improve']
const rank = (s: Stage) => order.indexOf(s)

/** Every event the flow has written up to and including the moment's stage, oldest first. */
export function eventsAt(m: Moment): LogEvent[] {
  const flow = flows[m.flow]
  const out: LogEvent[] = []
  const push = (lines: { effect?: { log?: LogEvent[] } }[], tone: Tone) => {
    for (const l of lines) for (const e of l.effect?.log ?? []) out.push({ tone, ...e })
  }
  for (const step of flow.steps as Step[]) {
    if (rank(step.stage) > rank(m.stage)) continue
    // the loop step is "in progress" at the loop stage: only its first task has written anything
    const partial = step.kind === 'exec' && m.stage === 'loop'
    if (step.kind === 'exec' && step.tranche) {
      const tasks = partial ? step.tranche.tasks.slice(0, 1) : step.tranche.tasks
      for (const t of tasks) push(execScript(t, 'claude'), 'exec')
      continue
    }
    if (step.kind === 'archive') {
      push(step.closingLines ?? [], 'retro')
      continue
    }
    push(linesFor(step, m.flow, 'claude'), step.stage === 'architect' && m.flow === 'hot' ? 'hot' : 'think')
    if (step.after) out.push(...step.after)
  }
  return out
}

type LiveRow = {
  label: string
  issue: number
  state: 'queued' | 'running' | 'done' | 'hot'
  segments: [number, number, Tone][]
}

/** The flow's tasks as Mission Control rows at the moment. */
export function rowsAt(m: Moment): LiveRow[] {
  const flow = flows[m.flow]
  const r = rank(m.stage)
  const tasks: Task[] = flow.tranches.flatMap((t) => t.tasks)
  if (m.flow === 'hot') {
    const t = tasks[0] as Task
    const state = r < rank('loop') ? 'queued' : r <= rank('merge') ? 'hot' : 'done'
    return [
      {
        label: 'hot',
        issue: t.issue,
        state,
        segments: state === 'queued' ? [] : [[0, state === 'done' ? 100 : 70, state === 'done' ? 'retro' : 'hot']]
      }
    ]
  }
  return tasks.map((t, i) => {
    let state: LiveRow['state'] = 'queued'
    if (r > rank('loop')) state = 'done'
    else if (r === rank('loop')) state = i === 0 ? 'done' : i === 1 ? 'running' : 'queued'
    const segments: [number, number, Tone][] =
      state === 'done' ? [[0, 100, 'retro']] : state === 'running' ? [[0, 55, 'exec']] : []
    return { label: `loop ${i + 1}`, issue: t.issue, state, segments }
  })
}
