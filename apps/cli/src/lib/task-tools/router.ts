/**
 * Routes a caller's free-text intent to the one catalog tool that answers
 * it (O3) — never to a mutating handler by mistake when the caller only
 * meant to read. This is intent classification only: it returns a
 * `TaskToolName` or `null` (no intent recognized), never calls a handler
 * itself. Order matters — cancel/resume/start are checked before status/
 * escalation, so an utterance naming a control verb ("cancel the paused
 * task") is never misread as a status question just because it also
 * mentions a state word.
 *
 * This module is also where the Operator's grant is enforced
 * (`refuseUngrantedTool`, O2): the router refuses any tool outside the grant
 * declared in `aeg-root/roles/operator.md` and mirrored by
 * `OPERATOR_TOOL_GRANT`. Classification answers "which tool does this
 * utterance mean?"; the grant check answers the prior question "may the
 * Operator call that tool at all?" — a shell, a forge write, an Issue edit, a
 * review publish or a merge is never in the grant, so it is refused here,
 * before any handler is reached.
 */

import { isOperatorGranted, OPERATOR_TOOL_GRANT, taskToolError, type TaskToolError } from '@attalabs/aeg-core'
import type { TaskToolName } from '@attalabs/aeg-core'

const CANCEL_WORDS = /\b(cancel|abort|kill|stop|terminate)\b/i
const RESUME_WORDS = /\b(resume|continue|carry on|pick .* back up|unpause)\b/i
const START_WORDS = /\b(start|kick off|begin|dispatch|launch)\b/i
const ESCALATION_WORDS =
  /\b(escalat\w*|why.*paused|why.*stuck|packet|stuck|blocked on|needs a ruling|needs a decision)\b/i
const STATUS_WORDS = /\b(status|state|how.*(going|coming along|doing)|progress|check on|running\??|is it done)\b/i

export function routeTaskToolIntent(utterance: string): TaskToolName | null {
  if (CANCEL_WORDS.test(utterance)) return 'task_cancel'
  if (RESUME_WORDS.test(utterance)) return 'task_resume'
  if (ESCALATION_WORDS.test(utterance)) return 'task_escalation_read'
  if (START_WORDS.test(utterance)) return 'task_start'
  if (STATUS_WORDS.test(utterance)) return 'task_status'
  return null
}

/**
 * The router's grant gate (O2): given the tool a caller wants to invoke,
 * return an `authority` error when it falls outside the Operator's grant, or
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
