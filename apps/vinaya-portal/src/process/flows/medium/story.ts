import { type Tracker, trackerLabel } from '../../types'
import { giftCardWaves, mediumFlow } from './flow'
import { lineAt, MEDIUM_WINDOWS } from './progress'
import { giftCardsEpic, INTEGRATION, mediumFindings, mediumStats, mediumWhy, waveNames, waveTime } from './report'
import { EXEC_MARK, WRITTEN } from './scripts'

/** A span of `progress`: [from, to]. */
type Span = [number, number]

/**
 * Everything Medium work's scene draws, as plain data: the Epic, the tranche
 * and its waves, when each task's lane rises, is reviewed and lands, the
 * report and the new Epic. Built from the flow the left column renders, and
 * timed by its own lines (`lineAt`), so the drawing keeps time with the walk.
 */
export type MediumStory = {
  /** The reader's tracker: its name, what product writes there, its mark (an SVG path, 24 × 24). */
  tracker: { name: string; unit: string; mark: string }
  /** The board the Epic sits on. */
  board: string
  epic: { key: string; name: string; products: string[] }
  tranche: { id: string; base: string; integration: string }
  waves: {
    name: string
    tasks: {
      n: number
      title: string
      /** Runs after another task of its wave: the same file. */
      after?: number
      /** When its lane rises; when its agent starts (later than `rise` when it waits); the review's verdict; when it lands on the integration branch. */
      rise: Span
      build: number
      reject?: Span
      approve: Span
      land: Span
    }[]
    /** When the wave, tested together, merges to main. */
    merge: Span
  }[]
  /** Planning: when the wave columns open, and when the rows are written. */
  plan: { waves: Span; rows: Span }
  stats: { value: string; label: string; detail: string; hot?: boolean }[]
  waveTime: { lead: number; work: number; idle: number }[]
  findings: { found: string; change: string }[]
  why: string[]
  /** The approved change: the new Epic's title. */
  proposal: string
}

export function mediumStory(tracker: Tracker, mark: string): MediumStory {
  const steps = mediumFlow.steps
  const planner = steps.find((s) => s.stage === 'planner')
  const exec = steps.find((s) => s.kind === 'exec')
  const tranche = mediumFlow.tranches[0]
  // the Planner's lines: the waves are named on one, the rows written on another
  const pl = planner?.lines ?? []
  const pAt = (i: number, f = 1) => lineAt(MEDIUM_WINDOWS.planning, pl.length, i, f)
  const wavesLine = pl.findIndex((l) => l.text.startsWith('Three waves'))
  const rowsLine = pl.findIndex((l) => l.text.includes(WRITTEN))
  // the Operator's lines (the closing lines come after them, in their own window)
  const ex = exec?.lines ?? []
  const at = (i: number, f = 1) => lineAt(MEDIUM_WINDOWS.executing, ex.length, i, f)
  const span = (i: number, f0 = 0, f1 = 1): Span => [at(i, f0), at(i, f1)]
  const find = (s: string, from = 0) => {
    const i = ex.findIndex((l, k) => k >= from && l.text.includes(s))
    return i < 0 ? ex.length - 1 : i
  }
  const run = [1, 2, 3].map((w) => find(EXEC_MARK.waveRun(w)))
  // the wave's merge line comes after its run line (which names the wave too)
  const merged = run.map((r, w) => find(EXEC_MARK.waveMerged(w + 1), r + 1))
  const waits = find(EXEC_MARK.waits)
  const changes = find(EXEC_MARK.changes)
  const second = find(EXEC_MARK.secondRound, changes)
  // the first task, in full: its lane rises on its run command, approves on the reviewers' line, lands on its merge
  const approveFirst = find('both approve')
  const landFirst = find('  merged · #')

  type Lane = MediumStory['waves'][number]['tasks'][number]
  /** When each task moves, by wave: the lines it keeps time with. */
  const timeOf = (w: number, k: number, issue: number): Omit<Lane, 'n' | 'title'> => {
    const r = run[w] ?? 0
    const m = merged[w] ?? 0
    if (w === 0) {
      // wave 1 rises with the first command; its first task runs in full, the others land as "runs wave 1" types
      const rise = span(0, k * 0.15, 0.6 + k * 0.15)
      if (k === 0) return { rise, build: rise[1], approve: span(approveFirst), land: span(landFirst) }
      return {
        rise,
        build: rise[1],
        approve: span(r, 0.1 + k * 0.2, 0.35 + k * 0.2),
        land: span(r, 0.55 + k * 0.15, 0.7 + k * 0.15)
      }
    }
    // later waves rise on their headline, one lane after another
    const rise = span(r - 1, k * 0.1, 0.5 + k * 0.1)
    if (w === 1) {
      // wave 2: #518 first; #514 next; #515 is sent back once; #516 waits for #515 (the same file), then runs
      if (issue === 515)
        return {
          rise,
          build: rise[1],
          reject: span(changes, 0.2, 0.8),
          approve: span(second, 0, 0.4),
          land: span(second, 0.3, 0.7)
        }
      if (issue === 516)
        return { after: 515, rise, build: at(second, 0.6), approve: span(m, 0, 0.35), land: span(m, 0.3, 0.55) }
      if (issue === 514) return { rise, build: rise[1], approve: span(waits, 0.5, 1), land: span(changes, 0.2, 0.7) }
      return { rise, build: rise[1], approve: span(r, 0.5, 1), land: span(waits, 0, 0.6) }
    }
    // wave 3: five at once, all green on their first round, landing one after another
    return {
      rise,
      build: rise[1],
      approve: span(r, k * 0.15, 0.25 + k * 0.15),
      land: span(r, 0.2 + k * 0.17, 0.32 + k * 0.17)
    }
  }

  const waves: MediumStory['waves'] = giftCardWaves.map((ts, w) => {
    const tasks = ts.map((t, k) => ({ n: t.issue, title: t.title, ...timeOf(w, k, t.issue) }))
    // tested together, the wave merges to main once its last lane has landed
    const landed = Math.max(...tasks.map((t) => t.land[1]))
    const [m0, m1] = span(merged[w] ?? 0, w === 1 ? 0.6 : 0.2, 1)
    const from = Math.max(m0, landed)
    return { name: `wave ${w + 1} · ${waveNames[w] ?? ''}`, tasks, merge: [from, Math.max(m1, from + 0.002)] }
  })

  return {
    tracker: { name: trackerLabel[tracker], unit: tracker === 'jira' ? 'Epic' : 'Project', mark },
    board: 'Shop',
    epic: { key: `SHOP-${giftCardsEpic.n}`, name: giftCardsEpic.name, products: giftCardsEpic.products },
    tranche: { id: tranche?.name ?? '', base: 'main', integration: INTEGRATION },
    waves,
    plan: { waves: [pAt(wavesLine, 0), pAt(wavesLine)], rows: [pAt(rowsLine, 0), pAt(rowsLine)] },
    stats: mediumStats,
    waveTime,
    findings: mediumFindings,
    why: mediumWhy,
    proposal: mediumFindings[0]?.change ?? ''
  }
}
