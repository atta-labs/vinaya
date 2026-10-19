import { flows } from '../fixtures'
import {
  checkoutParts,
  checkoutProjects,
  improveFindings,
  improveProposals,
  improveStats,
  improveWhy,
  timeSplit
} from '../fixtures/lifecycle'
import { type Tracker, trackerLabel } from '../types'

/**
 * Everything the life-cycle scene draws for Complex work, as plain data: the
 * product Projects, the milestone and its tranches, the Log's stats and the
 * projects drafted from them. Built from the fixtures the left column renders,
 * so the drawing and the walk show the same things.
 */
export type LifecycleStory = {
  /** The reader's tracker: its name, what product writes there, its mark (an SVG path, 24 × 24) and a key prefix. */
  tracker: { name: string; unit: string; mark: string; key: string }
  target: string
  /** The Projects (features) the deploy delivers, each with the marks of the products it touches. */
  projects: { name: string; products: string[] }[]
  milestone: string
  branch: string
  /** The milestone's parts, one per tranche: a name, the Projects it is made from (indexes), its tasks. */
  tranches: { id: string; part: string; projects: number[]; tasks: { n: number; title: string; file: string }[] }[]
  stats: { value: string; label: string; detail: string; hot?: boolean }[]
  split: { label: string; share: number }[]
  /** What the Improver found in the report, and the change each asks for. */
  findings: { found: string; change: string }[]
  /** The report's lines that justify the approved change. */
  why: string[]
  proposals: { title: string; kind: string; text: string }[]
  /** Event lines for the Log, in the families the Log really writes. */
  log: [string, string][]
}

export function lifecycleStory(tracker: Tracker, mark: string): LifecycleStory {
  const feature = flows.feature
  const base = feature.tranches[0]?.tasks[0]?.base ?? 'milestone/checkout-v2'
  const milestone = base.replace('milestone/', '')
  const tasks = feature.tranches.flatMap((tr) => tr.tasks)
  return {
    tracker: {
      name: trackerLabel[tracker],
      unit: tracker === 'jira' ? 'Epic' : 'Project',
      mark,
      key: tracker === 'jira' ? 'SHOP' : 'CHK'
    },
    target: 'Checkout v2',
    projects: checkoutProjects,
    milestone,
    branch: base,
    tranches: feature.tranches.map((tr, i) => ({
      id: tr.name ?? '',
      part: checkoutParts[i]?.name ?? tr.name ?? '',
      projects: checkoutParts[i]?.projects ?? [],
      tasks: tr.tasks.map((t) => ({ n: t.issue, title: t.title, file: t.file }))
    })),
    stats: improveStats,
    split: timeSplit,
    findings: improveFindings,
    why: improveWhy,
    proposals: improveProposals,
    log: [
      ...tasks.flatMap((t): [string, string][] => [
        ['dev_review_loop.round_started', `#${t.issue} · round 1`],
        ['gate.summary', `#${t.issue} · ring 0 · ring 1 green`]
      ]),
      ...tasks.map((t): [string, string] => ['forge_write.written', `op=archive · #${t.issue}`]),
      ['forge_write.written', `op=milestone.close · ${milestone}`]
    ]
  }
}
