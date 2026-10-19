import { clamp01, rangeAt } from '@/ui/lib/math'
import { shownAt } from '../replay'
import type { Stage } from '../types'

/**
 * Where the life-cycle scene stands for a point in the walk: one `progress`
 * through the whole descent, plus `archive`, 0..1 through the Archivist's
 * closing lines, which closes the milestone one unit per typed line.
 *
 * Each stage owns a window of `progress`; inside it the scene follows the
 * step's typed lines (`shownAt`), so the drawing keeps time with the left
 * column. The scene's own cues (`TRAVEL`, `CUE_*` in lifecycle-scene.js) sit
 * inside these windows:
 *
 * - Upstream:  0 → 0.06, the product Projects (by scroll; it has no lines).
 * - Thinking:  0.06 → 0.24, the milestone container and its planned work.
 * - Planning:  0.24 → 0.40, the work lines up into tranche tables.
 * - Executing: 0.40 → 0.655 while the execution lines type (the task's run,
 *   its merge), then 0.655 → 0.80 and `archive` 0 → 1 while the closing lines
 *   type (the milestone comes down and closes).
 * - Self-improvement: 0.80 → 0.92, the report, then the Improver's analysis of
 *   it (by scroll: its few lines type early and the drawing follows).
 * - Back upstream (the outro): 0.92 → 1, the tracker again, the new Project
 *   and the report that justifies it.
 *
 * `lines` and `closing` are the step's line count and how many of them are the
 * archive's closing lines (the last ones); `q` is the scroll progress through it.
 */
const LIFECYCLE_WINDOWS = {
  upstream: [0, 0.06],
  thinking: [0.06, 0.24],
  planning: [0.24, 0.4],
  executing: [0.4, 0.655],
  closing: [0.655, 0.8],
  improving: [0.8, 0.92],
  outro: [0.92, 1]
} as const

export function lifecycleProgress(
  stage: Stage,
  q: number,
  lines = 0,
  closing = 0,
  /** The walk's last step, back outside Vinaya after Self-improvement. */
  outro = false
): { progress: number; archive: number } {
  const W = LIFECYCLE_WINDOWS
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
      return { progress: rangeAt(W.thinking, lines ? typed(lines) / lines : q), archive: 0 }
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
