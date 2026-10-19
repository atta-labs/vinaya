import type { ChatLine, Flow, Step, Task, Tranche } from '../types'
import { improverChat } from './scripts'

/**
 * The step builders every flow shares. A flow that needs a step these do not
 * make writes it in its own folder (`src/process/flows/<flow>/`), not here.
 */

export const T = (
  issue: number,
  n: number | null,
  title: string,
  file: string,
  tranche: string | null,
  base: string
): Task => ({
  issue,
  n,
  title,
  file,
  tranche,
  base
})

/**
 * The upstream step: where the need comes from, before Vinaya. Only the flows
 * that have an upstream open with it; a backlog or hot Issue starts at the Issue.
 */
export const intro = (copy: { title: string; text: string }): Step => ({
  kind: 'intro',
  stage: 'upstream',
  eyebrow: 'Upstream · outside Vinaya',
  ...copy
})

export const execStep = (tr: Tranche, i: number, count: number): Step => {
  const single = !tr.name
  return {
    kind: 'exec',
    stage: 'loop',
    eyebrow: single ? 'Stage 2 · Executing' : `Stage 2 · Executing · tranche ${i + 1} of ${count}`,
    title: single
      ? 'Dispatch the Issue. One brief in, one reviewed pull request out.'
      : `Dispatch tranche ${tr.name}. ${tr.tasks.length} tasks, the same loop each.`,
    text: 'The Operator starts each task. The driver sends the work to the Developer in its sandbox on the Engine, reads the result, runs the gates, dispatches fresh reviewers, decides the next step. Rounds until green or a ruling. Every gate lands in the Log.',
    surface: 'terminal',
    tranche: tr
  }
}

export const archiveStep = (what: string, lines: ChatLine[], text: string, emphasis: string): Step => ({
  kind: 'archive',
  stage: 'archive',
  eyebrow: 'Stage 3 · Retrospecting',
  title: `At this point ${what} is done.`,
  text,
  emphasis,
  surface: 'terminal',
  closingLines: [...lines, { kind: 'out', text: 'retrospective kept · what shipped and why' }],
  banner: {
    title: `${what[0]?.toUpperCase()}${what.slice(1)} is closed.`,
    text: 'Every act above is in the Log. Studio already shows it. Open Map to see the whole path you just took.'
  },
  sceneAfter: { closed: true }
})

export const improveStep = (stats: [string, string, string]): Step => ({
  kind: 'improve',
  stage: 'improve',
  eyebrow: 'Stage 4 · Self-improvement',
  title: 'The Log teaches the process.',
  text: 'The Log writes a report from every run. The Improver reads it and proposes what to change. The Principal approves; the change goes back to product.',
  surface: 'claude',
  lines: improverChat,
  stats: [
    { value: stats[0], label: 'time per task' },
    { value: stats[1], label: 'green first round' },
    { value: stats[2], label: 'problems caught' }
  ],
  proposals: [
    {
      kind: 'Fix',
      title: 'Run the doc gate before push',
      text: 'cuts an expected 0.7 rounds per task',
      target: 'Linear'
    },
    { kind: 'New feature', title: 'Resume preview in Studio', text: 'shows what a ruling will change', target: 'Jira' }
  ]
})

export const closeTask = (t: Task, extra = ''): ChatLine => ({
  kind: 'ok',
  text: `archivist · #${t.issue} closed · merged${extra}`,
  effect: { log: [{ name: 'forge_write.written', detail: `op=archive · #${t.issue}`, tone: 'retro' }] }
})

export const closeTranche = (tr: Tranche): ChatLine => ({
  kind: 'ok',
  text: `${tr.name} archived`,
  effect: { log: [{ name: 'forge_write.written', detail: `op=archive · tranche ${tr.name}`, tone: 'retro' }] }
})

/**
 * Retrospecting is not a step of its own: it is automatic, and part of
 * executing. A flow's archive step is folded into the step before it (the
 * last execution): its closing lines run on in that terminal, after the merges.
 */
export function foldArchive(flow: Flow): Flow {
  const at = flow.steps.findIndex((s) => s.kind === 'archive')
  if (at < 1) return flow
  const archive = flow.steps[at] as Step
  const last = flow.steps[at - 1] as Step
  last.closingLines = [...(last.closingLines ?? []), ...(archive.closingLines ?? [])]
  flow.steps.splice(at, 1)
  return flow
}
