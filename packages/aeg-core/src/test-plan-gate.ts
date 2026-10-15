/**
 * Test Plan checkbox-state gate evaluator (later narrowed to `[principal]`
 * boxes only — the `[agent]` half stopped being a checkbox at all: it is a fenced command
 * list `vinaya pr report` executes and writes into the `AEG:EVIDENCE` block,
 * which IS the evidence, so there is nothing left for this gate to grade on
 * that half). Pure — no `fs`, no `gh`/`git`. The CLI shim
 * (`bin/verify-test-plan.ts`) reads `PR_BODY`/`BRANCH` from env and prints
 * this function's messages.
 *
 * See `locateTestPlanSection` for section-boundary detection (both the
 * inline `**Test Plan:**` marker and the `## N. Test Plan` heading form).
 * This module owns the checkbox tick-state decision built on top of it:
 *
 * - No section found, task branch → `fail` (a task PR without a
 *     Test Plan is malformed, not exempt — a real live-fire gap).
 *   - No section found, non-task branch (or no BRANCH) → `pass` (advisory).
 *   - `Test Plan: unit-tests-only` sentinel → `pass`.
 *   - Any unticked `- [ ]` `[principal]` checkbox → `fail`, naming every
 *     unticked line. A `[agent]`-tagged checkbox (an older body, still
 *     grandfathered by `brief-shape`'s own rollout) is never graded here —
 *     see the module doc comment above.
 *   - All `[principal]` boxes ticked (or none exist at all) → `pass`.
 *
 * The driver's `AEG:LIVE` record (`live-record.ts`) is graded alongside: each
 * unticked `[live]` line — a run that failed, or one the loop's host could not
 * verify — counts as an unticked `[principal]` box, and stops the
 * no-section and `unit-tests-only` passes above from applying.
 *
 * Given the frozen brief's `[live]` commands and the pull request's head
 * (`LiveGateInputs`), the gate fails closed: each command is decided from the
 * record's entry for it at that head, never from the record alone. A command
 * with no ticked entry at the head — no record at all, or an entry for an
 * older head only — counts as an unticked `[live]` line.
 */

import { type LiveRecordLine, readLiveRecord } from './live-record'
import { locateTestPlanSection } from './test-plan-section'
import { parseTaskBranchIdentity } from './task-branch-identity'

export type TestPlanGateVerdict = 'pass' | 'fail'
export type TestPlanGateResult = {
  verdict: TestPlanGateVerdict
  messages: string[]
}

/** The frozen brief's `[live]` commands (`parseLiveTestPlanItems`) and the pull request's head SHA they must have passed at. */
export type LiveGateInputs = {
  liveCommands: readonly string[]
  head: string
}

/**
 * The record's lines as the gate grades them. Without `live`, every line the
 * record carries. With it, each brief command is graded by its entry at
 * `live.head` — its ticked line when it passed there (or the Principal
 * ticked it), its unticked line when it failed or went unverified there, and
 * an unticked line naming the head when the record holds no entry for it at
 * that head — and the record's lines for any other command are kept as they
 * are.
 */
function gradedLiveLines(record: readonly LiveRecordLine[], live: LiveGateInputs | undefined): string[] {
  if (live === undefined) return record.map((entry) => entry.line)
  const commands = new Set(live.liveCommands)
  const others = record.filter((entry) => !commands.has(entry.command)).map((entry) => entry.line)
  const graded = live.liveCommands.map((command) => {
    const atHead = record.filter((entry) => entry.command === command && entry.head === live.head)
    return (
      (atHead.find((entry) => entry.ticked) ?? atHead[0])?.line ??
      `- [ ] **[live]** \`${command}\` — no passed run recorded at \`${live.head || 'an unknown head'}\``
    )
  })
  return [...others, ...graded]
}

export function evaluateTestPlanGate(body: string, branch: string, live?: LiveGateInputs): TestPlanGateResult {
  if (!body) {
    return {
      verdict: 'pass',
      messages: [
        'PR_BODY env var is empty; nothing to check.',
        'PASS (no body — likely a local invocation; CI sets PR_BODY automatically).'
      ]
    }
  }

  const located = locateTestPlanSection(body)
  // The driver's `AEG:LIVE` record (`live-record.ts`): an unticked line — a
  // `[live]` run that failed, or one the loop's host could not verify — holds
  // the merge exactly as an unticked `[principal]` box does, wherever in the
  // body the record sits and whatever the Test Plan section says.
  const liveLines = gradedLiveLines(readLiveRecord(body), live)
  const liveUnticked = liveLines.some((line) => /^[-*]\s+\[\s\]/.test(line))

  if (!located.found && !liveUnticked) {
    if (parseTaskBranchIdentity(branch) !== null) {
      return {
        verdict: 'fail',
        messages: [
          `FAIL — no Test Plan section found in the PR body for task branch \`${branch}\`.`,
          'Searched for a `## Test Plan` / `## N. Test Plan` heading and an inline `**Test Plan:**`/`Test Plan:` marker — neither was found.',
          'Per, a task PR without a Test Plan is malformed, not exempt — add one (or `Test Plan: unit-tests-only` for a pure-logic brief with no runtime surface).'
        ]
      }
    }
    return {
      verdict: 'pass',
      messages: [
        'No Test Plan section in PR body.',
        'PASS (advisory) — see aeg-root/roles/developer.md (Verification) and aeg-root/skills/brief-authoring/SKILL.md §9.',
        'Non-task branch (or BRANCH unset) — a brief that touches a runtime surface and has no Test Plan is malformed on a task branch; Brief Validation catches that case pre-dispatch.'
      ]
    }
  }

  const section = located.found ? located.section : ''

  if (/unit-tests-only/i.test(section) && !liveUnticked) {
    return {
      verdict: 'pass',
      messages: ['Test Plan: unit-tests-only — pure-logic brief, CI unit-tests are the proof.', 'PASS.']
    }
  }

  // `[agent]` checkboxes are never graded here — see the module doc comment.
  // An older body may still carry them (grandfathered by `brief-shape`'s
  // own rollout); this gate simply does not look at that tag at all any
  // more, ticked or not.
  const checkboxLines = [
    ...section
      .split('\n')
      .map((line) => line.trimStart())
      .filter((line) => /^[-*]\s+\[[ xX]\]\s*\*{0,2}\[principal\]\*{0,2}/i.test(line)),
    ...liveLines
  ]

  if (checkboxLines.length === 0) {
    return {
      verdict: 'pass',
      messages: [
        'Test Plan section found but has no `[principal]` checkbox items.',
        "PASS (advisory) — the section may be empty or expressed in prose; verification is the Principal's call."
      ]
    }
  }

  const unchecked = checkboxLines.filter((line) => /^[-*]\s+\[\s\]/.test(line))
  const checked = checkboxLines.filter((line) => /^[-*]\s+\[[xX]\]/.test(line))

  const messages = [`Test Plan [principal] items: ${checked.length} ticked, ${unchecked.length} unticked.`]

  if (unchecked.length > 0) {
    messages.push('', 'FAIL — the following [principal] Test Plan items are unticked:')
    for (const line of unchecked) messages.push(`  ${line}`)
    messages.push(
      '',
      'Per aeg-root/roles/developer.md (Verification), a PR is not mergeable while any [principal] Test Plan box is unticked.',
      'The Principal runs the item in a real signed-in browser and ticks the box.',
      ...(liveUnticked
        ? [
            'An unticked [live] line is a live run that failed or that the review loop could not verify on its host: a later head re-runs it, or the Principal runs it and ticks the box.'
          ]
        : []),
      'Note: editing the PR body does not retrigger most workflows. If your PR body changes do not surface here, push an empty commit to re-run.'
    )
    return { verdict: 'fail', messages }
  }

  messages.push('All [principal] Test Plan items ticked — runtime verification complete.', 'PASS.')
  return { verdict: 'pass', messages }
}
