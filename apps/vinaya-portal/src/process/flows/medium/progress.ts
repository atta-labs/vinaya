import { clamp01, rangeAt } from '@/ui/lib/math'
import { shownAt } from '../../replay'
import type { Stage } from '../../types'

/**
 * Where Medium work's scene stands for a point in the walk: one `progress`
 * through the whole descent, plus `archive`, 0..1 through the tranche's closing
 * lines, which closes it one unit per typed line. Copied from Complex work's
 * (`lifecycle/progress.ts`) with Medium's own windows: no Architect, no
 * milestone, and a longer Executing, where the waves run.
 *
 * - Upstream:  0 → 0.08, the one Epic (by scroll; it has no lines).
 * - Planning:  0.08 → 0.30, the tranche table fills, wave by wave.
 * - Executing: 0.30 → 0.70 while the Operator's lines type (the branch graph:
 *   lanes rise, are reviewed, land on the integration branch, waves merge to
 *   main), then 0.70 → 0.80 and `archive` 0 → 1 while the closing lines type.
 * - Self-improvement: 0.80 → 0.92, the report, then the Improver's findings.
 * - Back upstream (the outro): 0.92 → 1, the new Epic and its Why.
 *
 * `lines` and `closing` are the step's line count and how many of them are the
 * closing lines (the last ones); `q` is the scroll progress through it.
 */
export const MEDIUM_WINDOWS = {
  upstream: [0, 0.08],
  planning: [0.08, 0.3],
  executing: [0.3, 0.7],
  closing: [0.7, 0.8],
  improving: [0.8, 0.92],
  outro: [0.92, 1]
} as const

/** The progress at which a step's line `i` of `n` starts (`f` = 0) or has typed whole (`f` = 1), inside a window. */
export const lineAt = (w: readonly [number, number], n: number, i: number, f = 1) =>
  rangeAt(w, (i + f) / Math.max(1, n))

export function mediumProgress(
  stage: Stage,
  q: number,
  lines = 0,
  closing = 0,
  /** The walk's last step, back outside Vinaya after Self-improvement. */
  outro = false
): { progress: number; archive: number } {
  const W = MEDIUM_WINDOWS
  // the share of the step's lines typed at q, partial line included
  const typed = (n: number) => {
    if (!n) return clamp01(q)
    const { full, partial } = shownAt(n, q)
    return full + partial
  }
  if (outro) return { progress: rangeAt(W.outro, q), archive: 1 }
  switch (stage) {
    case 'upstream':
      return { progress: rangeAt(W.upstream, q), archive: 0 }
    case 'architect':
    case 'planner':
      return { progress: rangeAt(W.planning, lines ? typed(lines) / lines : q), archive: 0 }
    case 'loop':
    case 'gates':
    case 'merge':
    case 'archive': {
      if (!lines) return { progress: rangeAt(W.executing, q), archive: 0 }
      const t = typed(lines)
      const work = Math.max(1, lines - closing)
      const archive = closing ? clamp01((t - work) / closing) : 0
      return {
        progress: archive > 0 ? rangeAt(W.closing, archive) : rangeAt(W.executing, t / work),
        archive
      }
    }
    case 'improve':
    case 'observed':
      return { progress: rangeAt(W.improving, q), archive: 1 }
    default:
      return { progress: 1, archive: 1 }
  }
}
