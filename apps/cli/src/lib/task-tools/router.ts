/**
 * Routes a caller's free-text intent to the one catalog tool that answers
 * it (O3) — never to a mutating handler by mistake when the caller only
 * meant to read. This is intent classification only: it returns a
 * `TaskToolName` or `null` (no intent recognized), never calls a handler
 * itself. Order matters — cancel/resume/start are checked before status/
 * escalation, so an utterance naming a control verb ("cancel the paused
 * task") is never misread as a status question just because it also
 * mentions a state word.
 */

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
