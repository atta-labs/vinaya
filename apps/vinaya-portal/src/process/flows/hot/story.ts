import { agentName } from '../../fixtures/scripts'
import { type Agent, type Tracker, trackerLabel } from '../../types'
import { HOT_WINDOWS, lineAt } from './progress'
import { hotBrief, hotFinding, hotMonth, hotProposal, hotStats, hotWhy } from './report'
import { HOT_MARK, hotChat, hotExec, RUN_ID } from './scripts'

/** A span of `progress`: [from, to]. */
type Span = [number, number]

/**
 * Everything Hot issue's scene draws, as plain data: main, red; the hot Issue
 * and its brief; the branch the Principal and one agent work on; each gate as
 * it runs; the review, once; the merge; the report, its one finding and the
 * new Project. Built from the lines the left column types, and timed by them
 * (`lineAt`), so the drawing keeps time with the walk.
 */
export type HotStory = {
  /** The reader's tracker: its name, what product writes there, its mark (an SVG path, 24 × 24). */
  tracker: { name: string; unit: string; mark: string }
  /** The reader's agent, by name: the Principal's pair. */
  agent: string
  issue: { n: number; title: string; branch: string; run: string; pr: number }
  brief: { label: string; value: string }[]
  /** Who is speaking in the pairing, line by line: the Principal or the agent. */
  speakers: { who: 'you' | 'agent'; span: Span }[]
  /** When each thing happens. A gate's span runs from its hook starting to its green. */
  cue: {
    card: Span
    rows: Span
    fork: Span
    fix: Span
    commit: Span
    ring0Commit: Span
    push: Span
    ring0Push: Span
    pr: Span
    ci: Span
    review: Span
    approve: Span
    merge: Span
  }
  stats: { value: string; label: string; detail: string; hot?: boolean }[]
  month: { day: number; here: boolean }[]
  finding: { found: string; change: string }
  why: string[]
  /** The approved change: the new Project's title. */
  proposal: string
}

export function hotStory(tracker: Tracker, mark: string, agent: Agent): HotStory {
  const pl = hotChat(agent)
  const pAt = (i: number, f = 1) => lineAt(HOT_WINDOWS.pairing, pl.length, i, f)
  const pFind = (s: string) =>
    Math.max(
      0,
      pl.findIndex((l) => l.text.includes(s))
    )
  const ex = hotExec
  const at = (i: number, f = 1) => lineAt(HOT_WINDOWS.executing, ex.length, i, f)
  const span = (i: number, f0 = 0, f1 = 1): Span => [at(i, f0), at(i, f1)]
  const find = (s: string) =>
    Math.max(
      0,
      ex.findIndex((l) => l.text.includes(s))
    )

  const written = pFind(HOT_MARK.written)
  const started = pFind(HOT_MARK.started)
  const fixed = pFind(HOT_MARK.fixed)
  const commit = find(HOT_MARK.commit)
  const push = find(HOT_MARK.push)
  const pr = find(HOT_MARK.pr)
  const review = find(HOT_MARK.review)

  return {
    tracker: { name: trackerLabel[tracker], unit: tracker === 'jira' ? 'Epic' : 'Project', mark },
    agent: agentName(agent),
    issue: { n: 1001, title: 'Fix flaky CLI test', branch: 'task/issue-1001', run: RUN_ID, pr: 1472 },
    brief: hotBrief,
    speakers: pl.flatMap((l, i) =>
      l.kind === 'me' || l.kind === 'ag'
        ? [{ who: l.kind === 'me' ? ('you' as const) : ('agent' as const), span: [pAt(i, 0), pAt(i)] as Span }]
        : []
    ),
    cue: {
      card: [pAt(written, 0), pAt(written, 0.4)],
      rows: [pAt(written, 0.3), pAt(written)],
      fork: [pAt(started, 0), pAt(started)],
      fix: [pAt(fixed, 0), pAt(fixed)],
      commit: span(commit),
      ring0Commit: [at(commit + 1, 0), at(find(HOT_MARK.ring0Commit))],
      push: span(push),
      ring0Push: [at(push + 1, 0), at(find(HOT_MARK.ring0Push))],
      pr: span(pr),
      ci: [at(pr + 1, 0), at(find(HOT_MARK.ci))],
      review: [at(review, 0), at(find(HOT_MARK.reviewers))],
      approve: span(find(HOT_MARK.approved)),
      merge: span(find(HOT_MARK.merged))
    },
    stats: hotStats,
    month: hotMonth,
    finding: hotFinding,
    why: hotWhy,
    proposal: hotProposal
  }
}
