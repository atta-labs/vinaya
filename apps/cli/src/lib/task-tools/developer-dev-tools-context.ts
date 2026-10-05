/**
 * The real, gate-backed `DevToolContext` (O3) — the production counterpart to
 * the proof's deny-all `proofContext` and the harness's fakes. Each tool runs
 * the gates publishing already has IN THE DRIVER, then delegates only the
 * irreducible side effect (git commit/push, `gh` PR open/edit, `vinaya check
 * --all`, the Evidence refresh) to a closure the caller injects — so the driver
 * is where every gate decides, and the agent, inside its sandbox, holds no
 * forge credential of its own.
 *
 * Two invariants this factory enforces, both from the objective:
 *
 *  - **The gates run before the side effect.** `publish_changes` validates the
 *    commit header and the publication preconditions before it ever calls the
 *    injected commit/push (whose own protected-path and pre-push gates then
 *    run); `open_pull_request`/`update_pull_request_body` validate the body
 *    first. A failing gate returns a structured `DevToolRefusal` naming the
 *    gate, its output and the fix — the side effect never runs.
 *  - **A refusal never pauses the loop.** No method throws: an injected closure
 *    that rejects is caught and returned as a refusal on the MCP error channel,
 *    the same shape a gate refusal takes, so the agent sees a failed tool call
 *    and acts on it rather than the driver halting.
 */

import {
  checkPublicationPreconditions,
  type PublicationCheckInput,
  validateCommitHeader
} from '../dev-review-loop/developer-publication.js'
import type { DevPullRequestView, DevToolRefusal, DevToolResult } from './dev-tools-server.js'
import type { DevToolContext } from './dev-tools-server.js'

/** A validation verdict for a PR body — the driver's own PR-body gate, injected so the loop supplies the real one. */
export type BodyValidation = { ok: true } | { ok: false; reason: string }

/**
 * The irreducible side effects the gate-backed context delegates to. Each is a
 * closure the loop binds to its own real git/`gh`/check machinery; the gates
 * themselves live in the factory, never here.
 */
export type DeveloperDevToolDeps = {
  /** The publication-precondition inputs (branch/head/base/changed paths/surface), read FRESH each time `publish_changes` runs. Async-tolerant: the loop resolves the merge base here. */
  readPublicationCheckInput: () => PublicationCheckInput | Promise<PublicationCheckInput>
  /** Commit the worktree under the already-validated header and push; the protected-path and pre-push gates live inside this closure (the loop's real commit/push). */
  commitAndPush: (header: string) => Promise<DevToolResult<{ pushedHead: string }>>
  /** The driver's PR-body gate — validates a body before it is written to the forge. Async-tolerant: the loop's real gate runs `vinaya pr create`'s body checks. */
  validatePrBody: (body: string) => BodyValidation | Promise<BodyValidation>
  /** Open the task's PR with an already-validated title/body. */
  openPullRequest: (title: string, body: string) => Promise<DevToolResult<{ prNumber: number }>>
  /** Replace the PR body (already validated). */
  updatePullRequestBody: (body: string) => Promise<DevToolResult<{ prNumber: number }>>
  /** Regenerate the PR body's Evidence block for the current head, running the checks it attests. */
  refreshEvidence: () => Promise<DevToolResult<{ head: string; checksPassed: boolean; evidence: string }>>
  /** Read the PR — state, checks, reviews, body. */
  readPullRequest: () => Promise<DevToolResult<DevPullRequestView>>
  /** Run `vinaya check --all` for the current head. */
  runChecks: () => Promise<DevToolResult<{ passed: boolean; output: string }>>
}

/** A structured refusal, as a failed `DevToolResult`. */
function refuse<T>(check: string, output: string, fix: string): DevToolResult<T> {
  const error: DevToolRefusal = { check, output, fix }
  return { ok: false, error }
}

/**
 * Run an injected side-effect closure so it can NEVER throw past the context: a
 * rejected promise becomes a structured refusal on the error channel, so the
 * driver returns it to the agent instead of pausing the loop.
 */
async function guard<T>(check: string, run: () => Promise<DevToolResult<T>>): Promise<DevToolResult<T>> {
  try {
    return await run()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return refuse<T>(check, message, `The ${check} step threw: investigate the driver log and retry.`)
  }
}

/**
 * Build the production `DevToolContext` from the loop's own publication
 * closures. The gates (`validateCommitHeader`, `checkPublicationPreconditions`,
 * the injected PR-body validator) run in this factory; only the side effects
 * are delegated.
 */
export function createDeveloperDevToolContext(deps: DeveloperDevToolDeps): DevToolContext {
  return {
    publishChanges: (header) =>
      guard('publish_changes', async () => {
        const validated = validateCommitHeader(header)
        if (!validated.ok) {
          return refuse(
            'commit-header',
            validated.reason,
            'Rewrite the header as a single `Type(scope): Description` line.'
          )
        }
        const preconditions = checkPublicationPreconditions(await deps.readPublicationCheckInput())
        if (!preconditions.ok) {
          return refuse(
            'publication-preconditions',
            preconditions.reason,
            'Resolve the precondition named above before publishing.'
          )
        }
        // The protected-path and pre-push gates run inside this closure.
        return deps.commitAndPush(validated.header)
      }),
    openPullRequest: (title, body) =>
      guard('open_pull_request', async () => {
        const validated = await deps.validatePrBody(body)
        if (!validated.ok) {
          return refuse('pr-body-gate', validated.reason, 'Fix the PR body to satisfy the body gate, then reopen.')
        }
        return deps.openPullRequest(title, body)
      }),
    updatePullRequestBody: (body) =>
      guard('update_pull_request_body', async () => {
        const validated = await deps.validatePrBody(body)
        if (!validated.ok) {
          return refuse(
            'pr-body-gate',
            validated.reason,
            'Fix the PR body to satisfy the body gate, then update again.'
          )
        }
        return deps.updatePullRequestBody(body)
      }),
    refreshEvidence: () => guard('refresh_evidence', deps.refreshEvidence),
    readPullRequest: () => guard('read_pull_request', deps.readPullRequest),
    runChecks: () => guard('run_checks', deps.runChecks)
  }
}
