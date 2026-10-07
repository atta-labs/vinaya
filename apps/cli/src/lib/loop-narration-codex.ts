import {
  type ActionKind,
  classifyCommand,
  classifyDriverTool,
  firstLine,
  type NarratedAction,
  type NarratedResult,
  type NarratedUpdate,
  type NarrationContext,
  type NarrationState,
  reportingAction,
  relativePath,
  scrub,
  shorten
} from './loop-narration-claude'

/**
 * Translates one Codex `--json` event into the same plain actions the Claude
 * translator produces, from the items a real Codex developer run records:
 * `command_execution`, `file_change`, `mcp_tool_call` and `agent_message`.
 *
 * Like the Claude side it is a pure function that reads no clock and keeps
 * nothing of a payload: a command keeps its first words and its exit status,
 * never its output; a file change keeps each path and the kind of change,
 * never content; a tool call keeps its name (and a documentation URL), never
 * its arguments or result. An event or item type it does not recognise yields
 * nothing and never throws.
 *
 * Gemini is deliberately minimal. Its streaming shape has never been checked
 * against a real run, so `translateGeminiEvent` recognises only the session
 * start (the one event the existing renderer already trusts) and returns one
 * `working` action for it, and nothing for any other event.
 */

const SUBJECT_MAX = 80

type Json = Record<string, unknown>

function record(value: unknown): Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : {}
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** A Codex command is the shell's `-c` argument: `/bin/zsh -lc "<command>"`. Returns that command's first line. */
function unwrapShell(command: string): string {
  const prefix = /^(?:\S*\/)?(?:ba|z|da)?sh\s+-\w*c\s+/.exec(command.trim())
  let inner = command.trim()
  if (prefix !== null) {
    inner = inner.slice(prefix[0].length)
    const quote = inner[0]
    if (quote === "'" || quote === '"') {
      inner = inner.slice(1)
      if (inner.endsWith(quote)) inner = inner.slice(0, -1)
      if (quote === '"') inner = inner.replace(/\\(["\\$`])/g, '$1')
    }
  }
  return inner.split('\n').find((l) => l.trim().length > 0) ?? ''
}

const CHANGE_KINDS: Record<string, ActionKind> = { add: 'creating', update: 'editing', delete: 'removing' }

/** The turn result as the agent's final message carries it: `{"turnResult": {...}}`, as JSON text. */
function turnResultBody(text: string): Json | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') || !trimmed.includes('"turnResult"')) return null
  try {
    const parsed = record(JSON.parse(trimmed))
    return 'turnResult' in parsed ? record(parsed.turnResult) : null
  } catch {
    // Cut off or malformed: still the turn result, so still never printed.
    return {}
  }
}

interface Call {
  /** One call per path for a file change; the item's own id otherwise. */
  id: string
  kind: ActionKind
  subject: string
}

function callsOf(item: Json, ctx: NarrationContext): Call[] {
  const id = str(item.id)
  switch (item.type) {
    case 'command_execution': {
      const { kind, subject } = classifyCommand(unwrapShell(str(item.command)), ctx)
      return [{ id, kind, subject }]
    }
    case 'file_change': {
      const changes = Array.isArray(item.changes) ? item.changes : []
      return changes.flatMap((raw, i) => {
        const change = record(raw)
        const path = str(change.path)
        if (path === '') return []
        return [
          { id: `${id}#${i}`, kind: CHANGE_KINDS[str(change.kind)] ?? 'editing', subject: relativePath(path, ctx) }
        ]
      })
    }
    case 'mcp_tool_call': {
      const tool = str(item.tool)
      const driver = classifyDriverTool(tool, record(item.arguments), ctx)
      return [
        driver !== null
          ? { id, ...driver }
          : { id, kind: 'tool_request', subject: shorten(scrub(tool, ctx), SUBJECT_MAX) }
      ]
    }
    default:
      return []
  }
}

/** A failure's one line: a command's exit status, a tool's refusal text; never output. */
function failureLine(item: Json, ctx: NarrationContext): string {
  if (item.type === 'command_execution') {
    return typeof item.exit_code === 'number' ? `exit ${item.exit_code}` : 'failed'
  }
  const refusal = record(record(record(item.result).structured_content).error)
  const text = str(refusal.output) || str(refusal.check) || str(record(item.error).message) || 'failed'
  return firstLine(text, ctx)
}

function succeeded(item: Json): boolean {
  if (item.type === 'command_execution')
    return item.status === 'completed' && (item.exit_code === 0 || item.exit_code === undefined)
  return item.status === 'completed'
}

function messageAction(item: Json, ctx: NarrationContext): NarratedAction[] {
  const text = str(item.text)
  const body = turnResultBody(text)
  const id = str(item.id) || null
  if (body !== null) return [{ type: 'action', id, at: ctx.now, ...reportingAction(body) }]
  if (text.trim() === '') return []
  return [{ type: 'action', id, at: ctx.now, kind: 'message', subject: firstLine(text, ctx) }]
}

/**
 * One Codex event in, zero or more updates out. A started item opens its
 * call; the completed item with the same id closes it as a success or a
 * failure with the time between the two. A completed item whose start was
 * never seen is reported as an action and a result at once, taking no time.
 */
export function translateCodexEvent(event: Json, state: NarrationState, ctx: NarrationContext): NarratedUpdate[] {
  try {
    if (event.type !== 'item.started' && event.type !== 'item.completed') return []
    const item = record(event.item)
    if (item.type === 'agent_message') return event.type === 'item.completed' ? messageAction(item, ctx) : []
    const calls = callsOf(item, ctx)
    const out: NarratedUpdate[] = []
    for (const call of calls) {
      const open = state.open.get(call.id)
      if (event.type === 'item.started') {
        if (open !== undefined) continue
        out.push({ type: 'action', id: call.id, at: ctx.now, kind: call.kind, subject: call.subject })
        state.open.set(call.id, { kind: call.kind, subject: call.subject, at: ctx.now })
        continue
      }
      if (open === undefined)
        out.push({ type: 'action', id: call.id, at: ctx.now, kind: call.kind, subject: call.subject })
      state.open.delete(call.id)
      const ok = succeeded(item)
      const result: NarratedResult = {
        type: 'result',
        id: call.id,
        kind: call.kind,
        subject: call.subject,
        ok,
        durationMs: open === undefined ? 0 : Math.max(0, ctx.now - open.at)
      }
      if (!ok) result.error = failureLine(item, ctx)
      out.push(result)
    }
    return out
  } catch {
    return []
  }
}

/** Gemini's stream shape is unverified: the session start is the one event narrated, as `working`; every other event yields nothing. */
export function translateGeminiEvent(event: Json, _state: NarrationState, ctx: NarrationContext): NarratedUpdate[] {
  if (event.type !== 'init') return []
  return [{ type: 'action', id: null, at: ctx.now, kind: 'working', subject: 'session started' }]
}
