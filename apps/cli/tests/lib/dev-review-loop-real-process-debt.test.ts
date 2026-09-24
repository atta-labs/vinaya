/**
 * Issue #709, O3 — the burn-down ceiling for `dev-review-loop.test.ts`'s
 * real-process call sites. The file is being converted from whole-CLI
 * subprocess spawns (`runLoop`/`runResume`/`runCancel`/`runDevReviewLoopArgs`/
 * `runLoopNoPauseCommentRetry`) to in-process `devReviewLoop()` calls through
 * the shared harness (`dev-review-loop-harness.ts`), one `describe` block at
 * a time, per the round-2 ruling on this task. A test whose subject is a real
 * process — exit status, a signal, the driver lock, the start-of-run sweep,
 * stdio shape, or `publishRound`'s own forge round-trip — stays on a real
 * process and carries a `// REAL PROCESS: <reason>` line naming why.
 *
 * This check enforces O3 mechanically and holds the conversion monotonic:
 * `TODAYS_UNREASONED_DEBT` is the count of real-process call sites NOT yet
 * carrying a reason line, at this head. It may only ever move DOWN — a call
 * migrated in-process, or a kept call given its `// REAL PROCESS:` reason,
 * lowers it; a new unreasoned real-process call added to the file fails the
 * build. As each `describe` block converts, this number is lowered to match,
 * until every remaining real-process call is reasoned and the ceiling is the
 * count of reason lines exactly.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TARGET = join(fileURLToPath(new URL('.', import.meta.url)), 'dev-review-loop.test.ts')

/** Every helper this file uses to run the loop as a real subprocess — see that file's own `runDevReviewLoopArgs`. */
const REAL_PROCESS_CALL = /\b(runLoop|runResume|runCancel|runDevReviewLoopArgs|runLoopNoPauseCommentRetry)\(/g
const REASON_MARKER = /\/\/ REAL PROCESS: \S/g

/**
 * Current count of real-process call sites NOT yet carrying a reason line
 * (`callSites - reasons`), across the whole file (helper definitions call
 * each other, so this over-counts "one per test" slightly — a monotonic
 * ceiling only needs to be stable and mechanically recomputable, not an
 * exact per-test census). Lowered as each `describe` block converts; the
 * `round 1 clean, ends on publish` block was the first, taking it from `135`.
 */
const TODAYS_UNREASONED_DEBT = 22

describe('dev-review-loop.test.ts — real-process debt never grows unreasoned (O3)', () => {
  it('every real-process call site beyond today’s recorded debt carries a `// REAL PROCESS:` reason', () => {
    const src = readFileSync(TARGET, 'utf8')
    const callSites = src.match(REAL_PROCESS_CALL)?.length ?? 0
    const reasons = src.match(REASON_MARKER)?.length ?? 0
    const unreasoned = callSites - reasons
    expect(unreasoned).toBeLessThanOrEqual(TODAYS_UNREASONED_DEBT)
  })
})
