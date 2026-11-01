/**
 * An agent step's final structured result, from the records its stdout was
 * framed into, the same shape whichever vendor ran it.
 *
 * - Claude Code (`-p --output-format stream-json --json-schema`) prints JSON
 *   events; its final `result` event carries the structured result as
 *   `structured_output` (as the CLI's own `turn-result.ts` reads it). A
 *   record that is not such an event is returned as it is.
 * - Codex (`exec --json --output-schema`) prints JSONL events. Its structured
 *   final message is the text of the last completed `agent_message` item,
 *   parsed as JSON. The stream ends with `turn.completed`, which is not the
 *   result.
 *
 * Returns undefined when there is no result to recover.
 */
export function structuredResult(records: readonly unknown[]): unknown {
  const last = records[records.length - 1]
  const claudeResult = last as { type?: unknown; structured_output?: unknown } | undefined
  if (claudeResult?.type === 'result' && claudeResult.structured_output !== undefined)
    return claudeResult.structured_output
  if (!isCodexEventStream(records)) return last
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i] as { type?: unknown; item?: { type?: unknown; text?: unknown } }
    if (record?.type !== 'item.completed' || record.item?.type !== 'agent_message') continue
    if (typeof record.item.text !== 'string') return undefined
    try {
      return JSON.parse(record.item.text)
    } catch {
      return undefined
    }
  }
  return undefined
}

const CODEX_EVENT_TYPES = new Set([
  'thread.started',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'item.started',
  'item.updated',
  'item.completed',
  'error'
])

/** A Codex `exec --json` stream: every record is an event whose `type` is one of Codex's event names. */
function isCodexEventStream(records: readonly unknown[]): boolean {
  if (records.length === 0) return false
  return records.every((record) => {
    const type = (record as { type?: unknown } | null)?.type
    return typeof type === 'string' && CODEX_EVENT_TYPES.has(type)
  })
}

/**
 * The vendor session a step's records name: the newest `session_id` (Claude's
 * events, as the executor reads them), else the Codex `thread.started`
 * event's `thread_id`, which `codex exec resume` takes.
 */
export function sessionIdOf(records: readonly unknown[]): string | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i] as { session_id?: unknown; type?: unknown; thread_id?: unknown } | null
    if (typeof record?.session_id === 'string') return record.session_id
    if (record?.type === 'thread.started' && typeof record.thread_id === 'string') return record.thread_id
  }
  return undefined
}
