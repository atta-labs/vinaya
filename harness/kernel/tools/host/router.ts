/**
 * Routes a caller's free-text intent to the one catalog tool that answers
 * it — never to a mutating handler by mistake when the caller only meant to
 * read. This is intent classification only: it returns a `TaskToolName` or
 * `null` (no intent recognized), never calls a handler itself. Order
 * matters — cancel/resume/start are checked before status/escalation, so an
 * utterance naming a control verb ("cancel the paused task") is never
 * misread as a status question just because it also mentions a state word.
 * `task_pr_read` is checked ahead of the escalation and status words for the
 * same reason in the other direction: "why is the PR red?" and "which check
 * failed?" are questions about the forge's own report on the pull request,
 * not about the locally persisted pause packet a `why.*stuck` utterance
 * means, and not about the one-line loop state `task_status` answers.
 *
 * This module is also where the task-tool seat's grant check lives
 * (`refuseUngrantedTool` on a router built by `createTaskToolRouter`): it
 * refuses any tool outside the grant the router policy carries. The policy —
 * the granted tools, the seat that holds them and who a refused call is asked
 * of instead — is supplied by the process; this module names no role.
 * Classification answers "which tool does this utterance mean?"; the grant
 * check answers the prior question "may the seat call that tool at all?" — a
 * shell, a forge write, an Issue edit, a review publish or a merge is never
 * in the grant. The task-tools server's `dispatchToolCall` is the one place a
 * caller-supplied tool name reaches this check on a real call path, so every
 * MCP call is refused there before its handler runs, not merely in this
 * module's own fixture.
 */

import { taskToolError, type TaskToolError } from '@attalabs/aeg-core'
import type { TaskToolName } from '@attalabs/aeg-core'

const CANCEL_WORDS = /\b(cancel|abort|kill|stop|terminate)\b/i
const RESUME_WORDS = /\b(resume|continue|carry on|pick .* back up|unpause)\b/i
const START_WORDS = /\b(start|kick off|begin|dispatch|launch)\b/i
const PR_READ_WORDS =
  /(\bpull request\b|\bpr\b|\bci\b|\bchecks\b|\bcheck[- ]?runs?\b|\bfailing\b|\bfailed\b|\bred\b|\bverdicts?\b|\breview record\b|\bmerge gate\b)/i
const ESCALATION_WORDS =
  /\b(escalat\w*|why.*paused|why.*stuck|packet|stuck|blocked on|needs a ruling|needs a decision)\b/i
const STATUS_WORDS = /\b(status|state|how.*(going|coming along|doing)|progress|check on|running\??|is it done)\b/i

export function routeTaskToolIntent(utterance: string): TaskToolName | null {
  if (CANCEL_WORDS.test(utterance)) return 'task_cancel'
  if (RESUME_WORDS.test(utterance)) return 'task_resume'
  if (PR_READ_WORDS.test(utterance)) return 'task_pr_read'
  if (ESCALATION_WORDS.test(utterance)) return 'task_escalation_read'
  if (START_WORDS.test(utterance)) return 'task_start'
  if (STATUS_WORDS.test(utterance)) return 'task_status'
  return null
}

/**
 * The facts the router's grant gate reads: the tools the seat may call, the
 * seat's name as its refusals print it, and who a call outside the grant is
 * asked of instead.
 */
export type RouterRolePolicy = {
  readonly grantedTools: readonly string[]
  /** The seat as a refusal names it, e.g. `the <seat>`; its possessive is this plus `'s`. */
  readonly seat: string
  /** Who an ungranted act is asked of instead, as the refusal's detail names them. */
  readonly askedOf: string
}

export type TaskToolRouter = {
  routeTaskToolIntent: (utterance: string) => TaskToolName | null
  refuseUngrantedTool: (requestedTool: string) => TaskToolError | null
}

/** Thrown when a router is built without its role policy — never a router with an empty or default grant. */
export class MissingRouterPolicyError extends Error {
  constructor() {
    super(
      'createTaskToolRouter: refusing to build without its role policy (roles) — a missing grant is never an empty one'
    )
    this.name = 'MissingRouterPolicyError'
  }
}

/**
 * Builds the router over the process's role policy. Its grant gate: given the
 * tool a caller wants to invoke, return an `authority` error when it falls
 * outside the seat's grant, or `null` when it is granted. This is the
 * mechanical form of the role doc's boundary — "a registered tool is a
 * capability; the grant is what says you may call it." A caller-supplied
 * claim of role authenticates nothing, so this takes only the requested tool
 * name, never a self-asserted identity: the grant is a fixed property of the
 * seat, not a value the caller sets. The refusal names the whole grant so the
 * caller sees exactly what it may reach instead.
 */
export function createTaskToolRouter(policies: { roles: RouterRolePolicy }): TaskToolRouter {
  const roles = policies?.roles
  if (
    roles === undefined ||
    roles === null ||
    !Array.isArray(roles.grantedTools) ||
    typeof roles.seat !== 'string' ||
    typeof roles.askedOf !== 'string'
  ) {
    throw new MissingRouterPolicyError()
  }
  return {
    routeTaskToolIntent,
    refuseUngrantedTool: (requestedTool) => {
      if (roles.grantedTools.includes(requestedTool)) return null
      return taskToolError(
        'authority',
        `${roles.seat} is not granted "${requestedTool}"`,
        `${roles.seat}'s grant is limited to: ${roles.grantedTools.join(', ')} — a shell, a forge write, an Issue edit, a review publish or a merge is asked of ${roles.askedOf}, never called here`
      )
    }
  }
}
