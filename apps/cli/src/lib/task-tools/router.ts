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
 * This module is also where the Operator's grant check lives
 * (`refuseUngrantedTool`): it refuses any tool outside the grant declared in
 * `aeg-root/roles/operator.md` and mirrored by `OPERATOR_TOOL_GRANT`.
 * Classification answers "which tool does this utterance mean?"; the grant
 * check answers the prior question "may the Operator call that tool at
 * all?" — a shell, a forge write, an Issue edit, a review publish or a merge
 * is never in the grant. `server.ts`'s `dispatchToolCall` is the one place a
 * caller-supplied tool name reaches this function on a real call path, so
 * every MCP call is refused there before its handler runs, not merely in
 * this module's own fixture.
 */

import { isOperatorGranted, OPERATOR_TOOL_GRANT, taskToolError, type TaskToolError } from '@attalabs/aeg-core'
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
 * The router's grant gate: given the tool a caller wants to invoke, return
 * an `authority` error when it falls outside the Operator's grant, or
 * `null` when it is granted. This is the mechanical form of the role doc's
 * boundary — "a registered tool is a capability; the grant is what says you
 * may call it." A caller-supplied claim of role authenticates nothing, so
 * this takes only the requested tool name, never a self-asserted identity:
 * the grant is a fixed property of the Operator seat, not a value the caller
 * sets. The refusal names the whole grant so the caller sees exactly what it
 * may reach instead.
 */
export function refuseUngrantedTool(requestedTool: string): TaskToolError | null {
  if (isOperatorGranted(requestedTool)) return null
  return taskToolError(
    'authority',
    `the Operator is not granted "${requestedTool}"`,
    `the Operator's grant is limited to: ${OPERATOR_TOOL_GRANT.join(', ')} — a shell, a forge write, an Issue edit, a review publish or a merge is asked of the Planner or Principal, never called here`
  )
}
