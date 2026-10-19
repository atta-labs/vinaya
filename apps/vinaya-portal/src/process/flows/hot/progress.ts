import { clamp01, rangeAt } from '@/ui/lib/math'
import { shownAt } from '../../replay'
import type { Step } from '../../types'

/**
 * Where Hot issue's scene stands for a point in the walk: one `progress`
 * through the whole descent, plus `archive`, 0..1 through the closing lines,
 * which close the Issue one unit per typed line. Copied from Medium work's
 * (`flows/medium/progress.ts`) with Hot's own windows: no upstream, no
 * planning; the Pairing and the gates take most of the descent.
 *
 * - Pairing:   0 → 0.30, main red, the hot Issue written, its branch forked.
 * - Executing: 0.30 → 0.72 while the gates' lines type (commit, push, CI,
 *   the review once, the merge), then 0.72 → 0.80 and `archive` 0 → 1 while
 *   the closing lines type (the Issue closes).
 * - Self-improvement: 0.80 → 0.92, the report, then the Improver's finding.
 * - Back upstream (the outro): 0.92 → 1, the new Project and its Why.
 *
 * Both working steps are `loop` steps, so the step says which one it is: the
 * one that carries the closing lines is Executing.
 */
export const HOT_WINDOWS = {
  pairing: [0, 0.3],
  executing: [0.3, 0.72],
  closing: [0.72, 0.8],
  improving: [0.8, 0.92],
  outro: [0.92, 1]
} as const

/** The progress at which a step's line `i` of `n` starts (`f` = 0) or has typed whole (`f` = 1), inside a window. */
export const lineAt = (w: readonly [number, number], n: number, i: number, f = 1) =>
  rangeAt(w, (i + f) / Math.max(1, n))

export function hotProgress(
  step: Step,
  q: number,
  /** The step's line count, closing lines included. */
  lines = 0
): { progress: number; archive: number } {
  const W = HOT_WINDOWS
  const closing = step.closingLines?.length ?? 0
  // the share of the step's lines typed at q, partial line included
  const typed = (n: number) => {
    if (!n) return clamp01(q)
    const { full, partial } = shownAt(n, q)
    return full + partial
  }
  if (step.outro) return { progress: rangeAt(W.outro, q), archive: 1 }
  if (step.stage === 'improve' || step.stage === 'observed') return { progress: rangeAt(W.improving, q), archive: 1 }
  if (!closing) return { progress: rangeAt(W.pairing, lines ? typed(lines) / lines : q), archive: 0 }
  const t = typed(lines)
  const work = Math.max(1, lines - closing)
  const archive = clamp01((t - work) / closing)
  return {
    progress: archive > 0 ? rangeAt(W.closing, archive) : rangeAt(W.executing, t / work),
    archive
  }
}
