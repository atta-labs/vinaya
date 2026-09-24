/**
 * Issue #709, O3 — `dev-review-loop.test.ts` drives its scenarios entirely
 * through real `runLoop`/`runResume`/`runCancel`/`runDevReviewLoopArgs`/
 * `runLoopNoPauseCommentRetry` subprocess calls today; none of its 166
 * `it(...)` blocks yet call `devReviewLoop()` in-process through its own
 * injectable `LoopDeps` (issue-709's O2). Converting the existing suite is a
 * larger, per-scenario undertaking than this task's own profile-first Part
 * could respons­ibly complete in one pass without risking a converted test
 * that silently stops exercising what it claimed to (see this task's PR —
 * Decisions section — for the sizing finding and the follow-up this leaves).
 *
 * This check does not require every existing test to carry a reason line
 * retroactively — that rewrite is the follow-up's job, not this file's. It
 * enforces the FORWARD-LOOKING half of O3 mechanically instead: a real-
 * process call site added to `dev-review-loop.test.ts` from here on must
 * either move to an in-process `devReviewLoop()` call, or carry a
 * `// REAL PROCESS: <reason>` comment on the line immediately above it
 * naming the process-level property it needs (exit codes, signals, the
 * driver lock, the start-of-run sweep, stdio shape) — the exact category
 * `roles/developer/reference.md`'s O3 language names. `TODAYS_UNREASONED_DEBT`
 * is this task's own measured count, recorded once, at this head — never
 * bumped up to make room for a new unreasoned call site; only migrating a
 * call to in-process, or adding a `// REAL PROCESS:` reason line to an
 * existing one, is allowed to move it, and only downward.
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
 * Measured on this task's own head (issue-709): every call site matching
 * `REAL_PROCESS_CALL` above, across the whole file (helper definitions call
 * each other, so this over-counts "one per test" slightly — a debt ceiling
 * only ever needs to be a stable, mechanically-recomputable number, not an
 * exact per-test census). Zero of them carry a `// REAL PROCESS:` reason
 * today, so the ceiling is this count minus zero.
 */
const TODAYS_UNREASONED_DEBT = 135

describe('dev-review-loop.test.ts — real-process debt never grows unreasoned (O3)', () => {
  it('every real-process call site beyond today’s recorded debt carries a `// REAL PROCESS:` reason', () => {
    const src = readFileSync(TARGET, 'utf8')
    const callSites = src.match(REAL_PROCESS_CALL)?.length ?? 0
    const reasons = src.match(REASON_MARKER)?.length ?? 0
    const unreasoned = callSites - reasons
    expect(unreasoned).toBeLessThanOrEqual(TODAYS_UNREASONED_DEBT)
  })
})
