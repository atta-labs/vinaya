import { type AgentLineParts, renderNarratedUpdate } from './agent-line.js'
import {
  createNarrationState,
  type NarratedUpdate,
  type NarrationContext,
  scrub,
  translateClaudeEvent
} from './loop-narration-claude.js'
import { translateCodexEvent, translateGeminiEvent, unwrapShell } from './loop-narration-codex.js'

type Json = Record<string, unknown>
type Translate = (
  event: Json,
  state: ReturnType<typeof createNarrationState>,
  ctx: NarrationContext
) => NarratedUpdate[]

const TRANSLATORS = { claude: translateClaudeEvent, codex: translateCodexEvent, gemini: translateGeminiEvent } as const

const DETAIL_LINES_MAX = 20
const DETAIL_LINE_MAX = 400

export interface AgentStreamRenderer {
  /** One parsed stream event as zero or more primary lines with their marks and detail lines. */
  render(event: Json): AgentLineParts[]
}

function record(value: unknown): Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : {}
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function textLines(text: string, ctx: NarrationContext): string[] {
  return scrub(text, ctx)
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0)
    .slice(0, DETAIL_LINES_MAX)
    .map((l) => (l.length > DETAIL_LINE_MAX ? `${l.slice(0, DETAIL_LINE_MAX - 3)}...` : l))
}

/** The shell command a call ran, by call id, in full: the one detail a translator's short subject leaves out. */
function commandsById(agent: keyof typeof TRANSLATORS, event: Json): Map<string, string> {
  const out = new Map<string, string>()
  if (agent === 'claude') {
    const content = record(event.message).content
    for (const raw of Array.isArray(content) ? content : []) {
      const block = record(raw)
      if (block.type === 'tool_use' && block.name === 'Bash' && str(block.id) !== '')
        out.set(str(block.id), str(record(block.input).command))
    }
  } else if (agent === 'codex') {
    const item = record(event.item)
    if (item.type === 'command_execution' && str(item.id) !== '') out.set(str(item.id), unwrapShell(str(item.command)))
  }
  return out
}

/** The agent's own words in an event: Claude's text blocks, Codex's message items. */
function wordsOf(agent: keyof typeof TRANSLATORS, event: Json): string {
  if (agent === 'claude' && event.type === 'assistant') {
    const content = record(event.message).content
    return (Array.isArray(content) ? content : [])
      .map(record)
      .filter((b) => b.type === 'text')
      .map((b) => str(b.text))
      .join('\n')
  }
  return ''
}

/** A Codex message item's full text, unless it is the turn result. */
function codexMessage(event: Json): string {
  const item = record(event.item)
  const text = str(item.text)
  return event.type === 'item.completed' && item.type === 'agent_message' && !text.includes('"turnResult"') ? text : ''
}

/** An event name such as `item.completed`: never shown to a reader. */
function isEventName(text: string): boolean {
  return /^[a-z_]+(?:\.[a-z_]+)+$/.test(text.trim())
}

/**
 * Each agent's live stream through its own translator, into the lines the
 * Readable Task Log specifies. An event the translator does not handle falls
 * back to the vendor's old `renderEvent` text as a `Working` line with that
 * text beneath it, and is dropped when that text is only an event name.
 */
export function createAgentStreamRenderer(
  agent: keyof typeof TRANSLATORS,
  context: { worktree: string; home: string },
  renderEvent: (event: Json) => string | null,
  now: () => number = Date.now
): AgentStreamRenderer {
  const state = createNarrationState()
  const translate: Translate = TRANSLATORS[agent]
  return {
    render(event) {
      const ctx: NarrationContext = { ...context, now: now() }
      const lines: AgentLineParts[] = []
      const words = wordsOf(agent, event)
      if (words.trim() !== '') lines.push({ words: 'Writing', mark: 'working', details: textLines(words, ctx) })
      const updates = translate(event, state, ctx)
      const commands = commandsById(agent, event)
      for (const update of updates) {
        const parts = renderNarratedUpdate(update)
        const command = update.type === 'action' && update.id !== null ? commands.get(update.id) : undefined
        if (command !== undefined && command !== '') parts.details.push(...textLines(command, ctx))
        if (update.type === 'action' && update.kind === 'message') {
          const full = codexMessage(event)
          if (full !== '') parts.details = textLines(full, ctx)
        }
        lines.push(parts)
      }
      if (lines.length > 0) return lines
      const fallback = renderEvent(event)
      if (!fallback) return []
      const rendered = fallback
        .split('\n')
        .map((l) => l.replace(/^[⏵⏹]\s*/, ''))
        .filter((l) => l.trim() !== '')
      if (rendered.length === 0 || isEventName(rendered[0] ?? '')) return []
      return [{ words: 'Working', mark: 'working', details: textLines(rendered.join('\n'), ctx) }]
    }
  }
}
