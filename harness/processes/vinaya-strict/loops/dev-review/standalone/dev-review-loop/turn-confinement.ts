import type { LoopRunContext } from './run-context.js'
import type { Role } from '../../../../../../kernel/log/schema'
import { configPath } from '../../../../integration/config/compose.js'
import { createWorkerBoundary } from '../../../../../../kernel/isolation/worker-boundary.js'
import { vinayaWorkerBoundaryPolicies } from '../../../../integration/policies/vinaya-policies.js'

import { startTurnWriteAttribution } from '../../../../../../kernel/isolation/worker-boundary.js'
import { taskControlDir } from '../../../../../../kernel/isolation/worker-boundary.js'
import { documentationReceiptsPathForTask } from './developer-context.js'
import type { CredentialFinding } from '../../../../../../kernel/isolation/worker-boundary.js'
import { findCredentialPatterns } from '../../../../../../kernel/isolation/worker-boundary.js'

import type { DispatchHandle } from '../../dispatch/dispatch.js'
import { runPath } from '../../../../../../kernel/run-paths.js'
import { readIfExists } from './reviewer-dispatch.js'
import { developerWrittenTextFromVendorOutput } from '../../dispatch/dispatch.js'
import { worktreePathForBranch } from './developer-prompts.js'
import { existsSync } from 'node:fs'
import { addedDiffLines } from '../../../../../../kernel/isolation/worker-boundary.js'

/**
 * O11 (round 2 review, MAJOR): whether THIS prompt carries the context
 * block above is never gated on `devResumeId !== null` (the vendor
 * session's own `-r <id>` eligibility) — a `--resume <pr>` run's very
 * first developer dispatch (the ruling-resume prompt) has no durable
 * resume record either (this driver never reads one for that path,
 * only the `existingPr` attach branch does), so gating on it silently
 * skipped the context block for exactly the prompt's own Origin
 * note was about. Every `dispatchDeveloper` call defaults
 * to carrying it; the one call site that must NOT (the genuinely fresh
 * round-1 dispatch, opening a brand-new session onto a brand-new
 * worktree the frozen brief itself already describes) passes
 * `skipResumeContext: true` explicitly.
 */
/**
 * O1: the task's own protected-path list for THIS turn (control store,
 * source receipts, other roles' folders, the policy configuration —
 * `protectedPathsForTurn`'s own doc comment), hashed fresh right before a
 * dispatch starts. `vinaya.config.json`'s own path is resolved here too
 * (`configPath()`, repo-local or the global fallback) rather than
 * resolved once at loop start, matching `resolveTaskSurface`'s own
 * "never cached across a round" posture elsewhere in this file.
 */
export function snapshotTurnConfinement(c: LoopRunContext, role: Role, roundNum: number): void {
  const { root, task } = c

  // O1/MINOR fix: a missing config (`configPath()` found neither a
  // repo-local nor a global file) drops only the one config-file entry
  // `protectedPathsForTurn` would otherwise add — control store, source
  // receipts and other roles' folders are still resolved and hashed, so
  // an unreadable config never fails this role's WHOLE check open.
  const vinayaConfigPath = configPath()
  const entries = createWorkerBoundary(vinayaWorkerBoundaryPolicies()).protectedPathsForTurn({
    runtimeDir: root,
    task: task,
    round: roundNum,
    role,
    vinayaConfigPath
  })
  // The control store and the documentation receipts file are the
  // entries the driver's own tools write during a turn; `driverToolCall`
  // (wrapped around every dev-tools call that writes,
  // `attributeDriverToolCalls`) re-baselines them after each call returns.
  c.turnConfinementByRole.set(
    role,
    startTurnWriteAttribution(entries, [taskControlDir(root, task), documentationReceiptsPathForTask(c)])
  )
}

/**
 * O1/O2: compares the live filesystem against `snapshotTurnConfinement`'s
 * own snapshot for THIS role, taken right before this same dispatch
 * started, and scans `scanTexts` (the turn's own raw output, and — for a
 * Developer turn only — its worktree diff) for a recognized credential
 * shape. Returns the empty-violations shape when nothing was ever
 * snapshotted for `role` (no dispatch of it has happened yet this loop) —
 * never a reason to treat this check as silently passed OR to refuse a
 * turn for a problem this check does not itself diagnose. Keyed by role
 * (round 2 review, MAJOR) so `code-reviewer` and `security`'s
 * concurrent dispatches never read each other's snapshot.
 */
export function checkTurnConfinement(
  c: LoopRunContext,
  role: Role,
  scanTexts: readonly { text: string; location: string }[]
): {
  changedPaths: string[]
  credentialFindings: CredentialFinding[]
} {
  const changedPaths = c.turnConfinementByRole.get(role)?.changedPaths() ?? []
  const credentialFindings = scanTexts.flatMap(({ text, location }) => findCredentialPatterns(text, location))
  return { changedPaths, credentialFindings }
}

/** O1/O2: one human-readable refusal line naming every changed path and every credential pattern's own name/location — never the credential's own matched value. */
export function describeTurnConfinementViolation(
  c: LoopRunContext,
  result: {
    changedPaths: string[]
    credentialFindings: CredentialFinding[]
  }
): string {
  const parts: string[] = []
  if (result.changedPaths.length > 0) {
    parts.push(`protected path(s) changed during this turn: ${result.changedPaths.join(', ')}`)
  }
  if (result.credentialFindings.length > 0) {
    parts.push(
      `a recognized credential pattern appeared in ${result.credentialFindings
        .map((f) => `${f.location} (${f.pattern})`)
        .join(', ')} — the value itself is never reported, only where it was found`
    )
  }
  return parts.join('; ')
}

/** O2: a dispatch's own raw vendor output (the dispatch tee, `output/<effectId>.log`) as a scan-text entry, when `handle.effectId` resolves to one that is actually readable — `null` otherwise, never faked. Shared by the Developer and Reviewer scan-text builders below. */
export function rawOutputScanText(
  c: LoopRunContext,
  handle: DispatchHandle
): { text: string; location: string } | null {
  const { root, task } = c

  if (!handle.effectId) return null
  const teePath = runPath(root, task, { area: 'output', file: `${handle.effectId}.log` })
  const raw = readIfExists(teePath)
  return raw ? { text: raw, location: `the turn's own raw output (${teePath})` } : null
}

/**
 * O4: the texts a Developer turn's after-dispatch credential scan reads —
 * ONLY what the turn itself WROTE, never what it read. Two halves, each
 * omitted (never faked) when it cannot be read:
 *
 *  - the Developer's OWN authored turn output — its messages and the tool
 *    invocations it issued — pulled from the raw vendor tee through that
 *    vendor's own event renderer (`developerWrittenTextFromVendorOutput`),
 *    which drops a tool RESULT (a file it read, a command's output) to
 *    nothing. Scanning the raw tee whole instead flagged this repository's
 *    own credential-shaped test FIXTURES the moment a turn merely READ one
 *    (round 2 security), refusing a turn that leaked nothing.
 *  - the lines this turn ADDED to the worktree (`addedDiffLines`), never the
 *    unchanged context a hunk sits beside — which, again, can carry a
 *    credential-shaped fixture the turn did not write.
 */
export function developerScanTexts(c: LoopRunContext, handle: DispatchHandle): { text: string; location: string }[] {
  const { d, dispatchAgent, publicationState } = c

  const texts: { text: string; location: string }[] = []
  const output = rawOutputScanText(c, handle)
  if (output) {
    const written = developerWrittenTextFromVendorOutput(output.text, dispatchAgent)
    if (written)
      texts.push({ text: written, location: "the Developer's own turn output (its messages and tool invocations)" })
  }
  const worktree = worktreePathForBranch(c)
  if (publicationState.turnPreHead !== null && existsSync(worktree)) {
    const diff = d.gitWorktreeDiffText(worktree, publicationState.turnPreHead)
    if (diff) {
      const added = addedDiffLines(diff)
      if (added) texts.push({ text: added, location: 'the diff lines this turn added to the worktree' })
    }
  }
  return texts
}

/** O2: a Reviewer/security turn never writes into a worktree of its own (its three hand-off files sit outside it) — the after-dispatch scan reads only its own raw vendor output. */
export function reviewerScanTexts(c: LoopRunContext, handle: DispatchHandle): { text: string; location: string }[] {
  const output = rawOutputScanText(c, handle)
  return output ? [output] : []
}
