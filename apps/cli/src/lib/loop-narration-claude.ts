import { redact } from '@attalabs/aeg-core'

/**
 * Translates one Claude stream event into plain actions: what the agent is
 * doing, to which target, and whether it worked.
 *
 * A pure function over `(event, state, context)`. It prints nothing, reads no
 * clock (the caller passes each event's receipt time) and keeps nothing of a
 * tool's payload: a write's content is the file, a result's content is the
 * bulk of a run and can carry secrets and absolute paths. What it keeps is a
 * kind, one subject naming the target, line counts for edits and creates, and
 * for a result only success or failure, the time the call took and a failure's
 * first line.
 */

export type ActionKind =
  | 'reading'
  | 'searching'
  | 'editing'
  | 'creating'
  | 'removing'
  | 'running_tests'
  | 'type_checking'
  | 'git'
  | 'github'
  | 'tool_request'
  | 'skill'
  | 'fetching'
  | 'delegating'
  | 'running'

/** One tool call. `id` is `null` when the stream carried none, so no result can ever match it. */
export interface NarratedAction {
  type: 'action'
  id: string | null
  kind: ActionKind
  subject: string
  /** Receipt time of the event that carried the call, as the caller passed it. */
  at: number
  /** Lines added and removed, counted from an edit's own old and new text. */
  added?: number
  removed?: number
  /** Line count of a created file; never its content. */
  lines?: number
}

/** The outcome of one call, matched to it by the call's identifier. */
export interface NarratedResult {
  type: 'result'
  id: string
  kind: ActionKind
  subject: string
  ok: boolean
  durationMs: number
  /** A failure's first error line, shortened and redacted. Absent on success. */
  error?: string
}

export type NarratedUpdate = NarratedAction | NarratedResult

/** A call with no result yet, and how long it has been waiting. */
export interface OpenAction {
  id: string
  kind: ActionKind
  subject: string
  openForMs: number
}

interface OpenCall {
  kind: ActionKind
  subject: string
  at: number
}

export interface NarrationState {
  open: Map<string, OpenCall>
}

export interface NarrationContext {
  /** The task's worktree; paths under it are made relative to it. */
  worktree: string
  /** The user's home, redacted wherever it appears. */
  home: string
  /** Receipt time of this event, in epoch milliseconds. */
  now: number
}

export function createNarrationState(): NarrationState {
  return { open: new Map() }
}

/** Every call that has no result yet, oldest first. */
export function openActions(state: NarrationState, now: number): OpenAction[] {
  return [...state.open.entries()]
    .map(([id, call]) => ({ id, kind: call.kind, subject: call.subject, openForMs: Math.max(0, now - call.at) }))
    .sort((a, b) => b.openForMs - a.openForMs)
}

const SUBJECT_MAX = 80
const ERROR_MAX = 160

function shorten(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text
}

function scrub(text: string, ctx: NarrationContext): string {
  let out = text
  if (ctx.worktree.length > 0) out = out.split(`${ctx.worktree}/`).join('').split(ctx.worktree).join('.')
  if (ctx.home.length > 0) out = out.split(ctx.home).join('~')
  return redact(out, ctx.home)
}

function relativePath(path: string, ctx: NarrationContext): string {
  return shorten(scrub(path, ctx), SUBJECT_MAX)
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Lines in a piece of text: none for the empty string, a trailing newline not counted as one more. */
function countLines(text: string): number {
  if (text === '') return 0
  const parts = text.split('\n')
  return text.endsWith('\n') ? parts.length - 1 : parts.length
}

/**
 * The fixed table of command words. A command word outside it is `running`,
 * never guessed further: a wrong `removing` is worse than a plain `running`.
 */
const COMMAND_KINDS: Record<string, ActionKind> = {
  rm: 'removing',
  git: 'git',
  gh: 'github',
  cat: 'reading',
  head: 'reading',
  tail: 'reading',
  ls: 'reading',
  grep: 'searching',
  rg: 'searching',
  find: 'searching',
  vitest: 'running_tests',
  jest: 'running_tests',
  pytest: 'running_tests',
  tsc: 'type_checking'
}

/** Package runners whose next word picks the kind: `bun test`, `npm run typecheck`. */
const RUNNERS = new Set(['bun', 'npm', 'pnpm', 'yarn', 'npx', 'bunx'])
const RUNNER_SCRIPT_KINDS: Record<string, ActionKind> = {
  test: 'running_tests',
  typecheck: 'type_checking'
}

const GIT_REMOVING = new Set(['rm', 'clean'])

function isAssignment(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)
}

function unquote(word: string): string {
  return word.replace(/^['"]|['"]$/g, '')
}

function classifyCommand(command: string, ctx: NarrationContext): { kind: ActionKind; subject: string } {
  // First segment only: a pipe or `&&` chain is classified by its first command.
  const segment = command.split(/&&|\|\||;|\|/)[0] ?? ''
  const words = segment
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0)
  while (words.length > 0 && isAssignment(words[0] as string)) words.shift()
  const first = words[0] ?? ''
  if (first === '') return { kind: 'running', subject: '' }

  const second = words[1] ?? ''
  let kind: ActionKind = COMMAND_KINDS[first] ?? 'running'
  let consumed = 1
  if (first === 'git' && GIT_REMOVING.has(second)) kind = 'removing'
  if (RUNNERS.has(first)) {
    const script = second === 'run' ? (words[2] ?? '') : second
    const viaRunner = RUNNER_SCRIPT_KINDS[script] ?? COMMAND_KINDS[script]
    if (viaRunner === 'running_tests' || viaRunner === 'type_checking') kind = viaRunner
    consumed = second === 'run' ? 3 : 2
  } else if (first === 'git') {
    consumed = 2
  } else if (first === 'gh') {
    consumed = 3
  }

  if (kind === 'running') {
    // Outside the table: its first words, nothing more.
    const subject = words.slice(0, 3).map(unquote).join(' ')
    return { kind, subject: shorten(scrub(subject, ctx), SUBJECT_MAX) }
  }
  const head = words.slice(0, consumed).map(unquote).join(' ')
  const target = words.slice(consumed).find((w) => !w.startsWith('-'))
  const subject = target === undefined ? head : `${head} ${unquote(target)}`
  return { kind, subject: shorten(scrub(subject, ctx), SUBJECT_MAX) }
}

function urlSubject(raw: string, ctx: NarrationContext): string {
  try {
    const url = new URL(raw)
    return shorten(scrub(`${url.host}${url.pathname}`, ctx), SUBJECT_MAX)
  } catch {
    return shorten(scrub(raw.split('?')[0] ?? '', ctx), SUBJECT_MAX)
  }
}

function classifyCall(
  name: string,
  input: Record<string, unknown>,
  ctx: NarrationContext
): Omit<NarratedAction, 'type' | 'id' | 'at'> {
  switch (name) {
    case 'Read':
    case 'NotebookRead':
      return { kind: 'reading', subject: relativePath(str(input.file_path) || str(input.notebook_path), ctx) }
    case 'Grep':
    case 'Glob':
      return { kind: 'searching', subject: shorten(scrub(str(input.pattern), ctx), SUBJECT_MAX) }
    case 'Edit': {
      return {
        kind: 'editing',
        subject: relativePath(str(input.file_path), ctx),
        added: countLines(str(input.new_string)),
        removed: countLines(str(input.old_string))
      }
    }
    case 'MultiEdit': {
      const edits = Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : []
      let added = 0
      let removed = 0
      for (const edit of edits) {
        added += countLines(str(edit?.new_string))
        removed += countLines(str(edit?.old_string))
      }
      return { kind: 'editing', subject: relativePath(str(input.file_path), ctx), added, removed }
    }
    case 'NotebookEdit':
      return {
        kind: 'editing',
        subject: relativePath(str(input.notebook_path), ctx),
        added: countLines(str(input.new_source)),
        removed: 0
      }
    case 'Write':
      return {
        kind: 'creating',
        subject: relativePath(str(input.file_path), ctx),
        lines: countLines(str(input.content))
      }
    case 'Bash':
      return classifyCommand(str(input.command), ctx)
    case 'WebFetch':
      return { kind: 'fetching', subject: urlSubject(str(input.url), ctx) }
    case 'WebSearch':
      return { kind: 'fetching', subject: shorten(scrub(str(input.query), ctx), SUBJECT_MAX) }
    case 'Skill':
      return { kind: 'skill', subject: shorten(scrub(str(input.skill), ctx), SUBJECT_MAX) }
    case 'Task':
    case 'Agent':
      return {
        kind: 'delegating',
        subject: shorten(scrub(str(input.description) || str(input.subagent_type), ctx), SUBJECT_MAX)
      }
    default:
      // An MCP tool or any tool outside the table: named, never described.
      return { kind: 'tool_request', subject: shorten(scrub(name, ctx), SUBJECT_MAX) }
  }
}

/** The first non-empty line of a failed result's text, shortened and redacted. */
function firstErrorLine(content: unknown, ctx: NarrationContext): string {
  let text = ''
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    text = (content as Record<string, unknown>[])
      .map((b) => (b?.type === 'text' ? str(b.text) : ''))
      .filter((t) => t.length > 0)
      .join('\n')
  }
  const line = text.split('\n').find((l) => l.trim().length > 0) ?? ''
  return shorten(scrub(line.trim(), ctx), ERROR_MAX)
}

/**
 * One Claude stream event in, zero or more updates out: an `action` for each
 * tool call, a `result` for each tool result whose call is known. A result
 * is matched by the call's identifier, never by order; a result naming no
 * known call, or an already-answered one, yields nothing. A call with no
 * identifier is reported as an action but cannot be tracked as open.
 */
export function translateClaudeEvent(
  event: Record<string, unknown>,
  state: NarrationState,
  ctx: NarrationContext
): NarratedUpdate[] {
  if (event.type !== 'assistant' && event.type !== 'user') return []
  const msg = event.message as { content?: unknown } | undefined
  const content = Array.isArray(msg?.content) ? (msg?.content as Record<string, unknown>[]) : []
  const out: NarratedUpdate[] = []
  for (const block of content) {
    if (block?.type === 'tool_use' && typeof block.name === 'string') {
      const input = (block.input ?? {}) as Record<string, unknown>
      const id = typeof block.id === 'string' && block.id.length > 0 ? block.id : null
      const classified = classifyCall(block.name, input, ctx)
      out.push({ type: 'action', id, at: ctx.now, ...classified })
      if (id !== null) state.open.set(id, { kind: classified.kind, subject: classified.subject, at: ctx.now })
    } else if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      const call = state.open.get(block.tool_use_id)
      if (call === undefined) continue
      state.open.delete(block.tool_use_id)
      const ok = block.is_error !== true
      const result: NarratedResult = {
        type: 'result',
        id: block.tool_use_id,
        kind: call.kind,
        subject: call.subject,
        ok,
        durationMs: Math.max(0, ctx.now - call.at)
      }
      // Success never reads the result's content; a failure keeps one line.
      if (!ok) result.error = firstErrorLine(block.content, ctx)
      out.push(result)
    }
  }
  return out
}
