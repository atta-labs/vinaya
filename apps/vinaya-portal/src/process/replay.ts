import { clamp01 } from '@/ui/lib/math'
import { flows, linesFor } from './fixtures'
import { execScript } from './fixtures/scripts'
import type { Agent, ChatLine, FlowKey, GateState, LogEvent, Stage, Step, Task, Tone } from './types'
import { toneOfStage } from './types'

/**
 * The interactive page has no clock: the reader's scroll is the only input.
 * A cursor (the step in view and how far through it the reader has scrolled)
 * replays the fixtures up to that point, so scrolling back undoes what
 * scrolling forward did. Everything here is pure.
 */

/** A step's lines finish at this share of its scroll; the rest holds the finished step on screen. */
export const LINES_END = 0.82

/** Lines of an `exec` step: every task of the tranche, separated by a headline. */
export function execLines(tasks: Task[], agent: Agent, tranche: string | null, full = tasks.length): ChatLine[] {
  const out: ChatLine[] = []
  tasks.slice(0, full).forEach((t, i) => {
    if (i > 0) out.push({ kind: 'hl', text: `── task ${t.n} · #${t.issue} · ${t.title}`, effect: { gates: [0, 0, 0] } })
    out.push(...execScript(t, agent))
  })
  // past the ones shown in full, the Operator's waves: one dispatch line and one merge line per tranche
  const rest = tasks.slice(full)
  const groups = [...new Set(rest.map((t) => t.tranche ?? ''))]
  for (const g of groups) {
    const ts = rest.filter((t) => (t.tranche ?? '') === g)
    out.push(
      {
        kind: 'ev',
        text: `the Operator runs ${g || 'the rest'} · ${ts.length} tasks in parallel (${agent})`,
        effect: { log: ts.map((t) => ({ name: 'dev_review_loop.loop_started', detail: `#${t.issue}` })) }
      },
      {
        kind: 'ok',
        text: `${g || 'tasks'} · ${ts.length} of ${ts.length} reviewed and merged → ${ts[0]?.base ?? 'main'}`,
        effect: { log: ts.map((t) => ({ name: 'forge_write.written', detail: `op=merge · #${t.issue}` })) }
      }
    )
  }
  if (tranche)
    out.push({
      kind: 'ok',
      text: `tranche ${tranche} · ${tasks.length} of ${tasks.length} merged`,
      effect: { log: [{ name: 'forge_write.written', detail: `op=archive · tranche ${tranche}`, tone: 'retro' }] }
    })
  return out
}

/** Every line a step types, for the reader's agent. */
export function stepLines(step: Step, flow: FlowKey, agent: Agent): ChatLine[] {
  if (step.kind === 'intro') return []
  if (step.kind === 'archive') return step.closingLines ?? []
  // An execution step carries the archive's closing lines after its own: closing is part of executing.
  const own =
    step.kind === 'exec' && step.tranche
      ? execLines(step.tranche.tasks, agent, step.tranche.name, step.logFull)
      : linesFor(step, flow, agent)
  return [...own, ...(step.closingLines ?? [])]
}

/** How many lines are on screen at `progress`: whole lines, and how much of the next one. */
export function shownAt(count: number, progress: number) {
  const v = clamp01(progress / LINES_END) * count
  const full = Math.min(count, Math.floor(v))
  return { full, partial: full < count ? v - full : 0 }
}

/** The tone a step's Log events carry. */
const toneOfStep = (step: Step, flow: FlowKey): Tone =>
  flow === 'hot' && step.stage === 'architect' ? 'hot' : toneOfStage[step.stage]

export type Cursor = { step: number; progress: number }
type TaskStatus = 'queued' | 'running' | 'done'
export type Replay = { log: LogEvent[]; gates: GateState; tasks: Record<number, TaskStatus> }

/** What the page shows at a cursor: the Log so far, the gates, each task's state. */
export function replay(flow: FlowKey, agent: Agent, cursor: Cursor): Replay {
  const steps = flows[flow].steps
  const log: LogEvent[] = []
  let gates: GateState = [0, 0, 0]
  const tasks: Record<number, TaskStatus> = {}
  for (let i = 0; i <= cursor.step && i < steps.length; i++) {
    const step = steps[i] as Step
    const lines = stepLines(step, flow, agent)
    const count = i < cursor.step ? lines.length : shownAt(lines.length, cursor.progress).full
    const tone = toneOfStep(step, flow)
    for (const line of lines.slice(0, count)) {
      for (const e of line.effect?.log ?? []) log.push({ tone, ...e })
      if (line.effect?.gates) gates = line.effect.gates
      if (step.tranche && line.text.startsWith('vinaya task run')) {
        const t = step.tranche.tasks.find(
          (x) => line.text.includes(`#${x.issue}`) || (x.n !== null && line.text.includes(` ${x.n} --agent`))
        )
        if (t) tasks[t.issue] = 'running'
      }
      const merged = line.text.match(/merged by the Principal · #(\d+)/)
      if (merged) tasks[Number(merged[1])] = 'done'
    }
    const finished = i < cursor.step || cursor.progress >= LINES_END
    if (finished && step.after) log.push(...step.after)
  }
  return { log, gates, tasks }
}

const stageOrder: Stage[] = [
  'upstream',
  'architect',
  'planner',
  'loop',
  'gates',
  'merge',
  'archive',
  'observed',
  'improve'
]

/** The diagram stage a walk step stands for: the picker has no `gates` or `observed`. */
export const diagramStageOf = (s: Stage): Stage => (s === 'gates' ? 'loop' : s === 'observed' ? 'archive' : s)

/**
 * Where the walk stands when the diagram picks a stage: the first step at that
 * stage with its lines done. `upstream` is the start; `merge` is the end of the
 * last loop; a stage the flow skips lands on the next step it has.
 */
export function cursorForStage(flow: FlowKey, stage: Stage): Cursor {
  const steps = flows[flow].steps
  if (stage === 'upstream') return { step: 0, progress: 0 }
  if (stage === 'merge') {
    const last = steps
      .map((s, i) => (s.stage === 'loop' ? i : -1))
      .filter((i) => i >= 0)
      .at(-1)
    if (last !== undefined) return { step: last, progress: 1 }
  }
  const at = stageOrder.indexOf(stage)
  const i = steps.findIndex((s) => stageOrder.indexOf(s.stage) >= at)
  return { step: i >= 0 ? i : steps.length - 1, progress: LINES_END }
}
