import type { Role } from '@attalabs/aeg-core'
import type { ActionKind, NarratedAction, NarratedUpdate } from './loop-narration-claude.js'

export type AgentLineMark = 'working' | 'done' | 'failed' | 'waiting' | 'round'

const roleLabels: Record<Role, string> = {
  planner: 'Planner',
  developer: 'Developer',
  'code-reviewer': 'Code review',
  security: 'Security',
  principal: 'Principal',
  archivist: 'Archivist',
  architect: 'Architect'
}

function roleLabel(role: Role | string): string {
  if (role in roleLabels) return roleLabels[role as Role]
  if (role === 'dev-review-loop') return 'Loop'
  if (role === 'operator') return 'Operator'
  return role.replace(/-/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

const unicodeMarks: Record<AgentLineMark, string> = { working: '▸', done: '✓', failed: '✕', waiting: '◌', round: '◆' }
const asciiMarks: Record<AgentLineMark, string> = { working: '>', done: '+', failed: 'x', waiting: '~', round: '#' }

export function logQuiet(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VINAYA_LOG_QUIET === '1' || env.VINAYA_LOG_QUIET === 'true'
}

/**
 * A driver-log record's metadata: fields a reader of the file uses to tell one
 * record from another without reading its words — an action's call identifier,
 * a detail that is the shell command, a stage change. Written only in the file,
 * as one bracketed token right after the ISO time, before any text an agent can
 * reach, so no agent output can forge it; a record without metadata reads
 * exactly as it always has.
 */
export type LineMeta = Readonly<Record<string, string | true>>

const META_KEY = /^[a-z]+$/
const META_VALUE = /^[A-Za-z0-9_.:#-]{1,200}$/

/** ` [key=value flag]`, or `''` when no field is writable; a key or value outside the grammar is left out. */
export function formatLineMeta(meta: LineMeta | undefined): string {
  if (meta === undefined) return ''
  const fields = Object.entries(meta)
    .filter(([key, value]) => META_KEY.test(key) && (value === true || META_VALUE.test(value)))
    .map(([key, value]) => (value === true ? key : `${key}=${value}`))
  return fields.length === 0 ? '' : ` [${fields.join(' ')}]`
}

/** The fields of a metadata token's inside (`key=value flag`); a field outside the grammar is dropped. */
export function parseLineMeta(inside: string): Record<string, string | true> {
  const out: Record<string, string | true> = {}
  for (const field of inside.split(' ')) {
    const eq = field.indexOf('=')
    const key = eq < 0 ? field : field.slice(0, eq)
    if (!META_KEY.test(key)) continue
    if (eq < 0) out[key] = true
    else if (META_VALUE.test(field.slice(eq + 1))) out[key] = field.slice(eq + 1)
  }
  return out
}

export function formatAgentLine(
  role: Role | string,
  words: string,
  options: { mark?: AgentLineMark; now?: Date; unicode?: boolean; log?: boolean; meta?: LineMeta } = {}
): string {
  const now = options.now ?? new Date()
  const time = options.log
    ? `${now.toISOString()}${formatLineMeta(options.meta)}`
    : now.toLocaleTimeString('en-GB', { hour12: false })
  const mark =
    (options.unicode ?? true) ? unicodeMarks[options.mark ?? 'working'] : asciiMarks[options.mark ?? 'working']
  return `${time}  ${mark} ${roleLabel(role)}   ${words}`
}

export function formatAgentDetails(details: readonly string[], quiet = logQuiet()): string[] {
  return quiet ? [] : details.filter(Boolean).map((detail) => `  · ${detail}`)
}

const actionVerbs: Record<ActionKind, string> = {
  reading: 'Reading',
  searching: 'Searching',
  editing: 'Editing',
  creating: 'Creating',
  removing: 'Removing',
  running_tests: 'Running tests',
  type_checking: 'Type-checking',
  git: 'Running git',
  github: 'Using GitHub',
  tool_request: 'Requesting tool',
  skill: 'Using skill',
  fetching: 'Fetching',
  delegating: 'Delegating',
  reporting: 'Reporting',
  running: 'Running',
  message: 'Writing',
  checking: 'Checking',
  publishing: 'Publishing',
  working: 'Working'
}

const resultVerbs: Record<ActionKind, string> = {
  reading: 'reading',
  searching: 'searching',
  editing: 'editing',
  creating: 'creating',
  removing: 'removing',
  running_tests: 'running tests',
  type_checking: 'type-checking',
  git: 'running git',
  github: 'using GitHub',
  tool_request: 'requesting tool',
  skill: 'using skill',
  fetching: 'fetching',
  delegating: 'delegating',
  reporting: 'reporting',
  running: 'running',
  message: 'writing',
  checking: 'checking',
  publishing: 'publishing',
  working: 'working'
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`
}

export interface AgentLineParts {
  words: string
  mark: AgentLineMark
  details: string[]
  /** The action's own call identifier, on its start and its finish alike; absent when the stream carried none. */
  callId?: string
  /** The index in `details` where the shell command's lines begin; absent when no detail is the command. */
  commandFrom?: number
}

/** `, 2 tests failed` for a test run whose own summary gave a count; nothing otherwise. */
function failedTestsMeta(failed: number | undefined): string {
  if (failed === undefined) return ''
  if (failed === 0) return ', no test failed'
  return `, ${failed} test${failed === 1 ? '' : 's'} failed`
}

function actionMeta(action: NarratedAction): string {
  if (action.kind === 'editing' && action.added !== undefined && action.removed !== undefined)
    return ` +${action.added} −${action.removed}`
  if (action.kind === 'creating' && action.lines !== undefined) return ` +${action.lines}`
  if (action.kind === 'reporting' && action.confidence !== undefined) return ` (confidence ${action.confidence})`
  return ''
}

/**
 * One narrated update as the words, mark and detail lines of a primary
 * record: an action is `<Verb> <subject> <meta>`, a success a done line with
 * its duration, a failure a failed line with its first error line beneath it.
 */
export function renderNarratedUpdate(update: NarratedUpdate): AgentLineParts {
  const call = update.id !== null && update.id !== '' ? { callId: update.id } : {}
  if (update.type === 'action') {
    if (update.kind === 'message')
      return { words: actionVerbs.message, mark: 'working', details: [update.subject], ...call }
    if (update.kind === 'working')
      return { words: `${actionVerbs.working}: ${update.subject}`, mark: 'working', details: [], ...call }
    return {
      words: `${actionVerbs[update.kind]} ${update.subject}${actionMeta(update)}`,
      mark: 'working',
      details: [],
      ...call
    }
  }
  const took = formatDuration(update.durationMs)
  const what = `${resultVerbs[update.kind]} ${update.subject}`
  const tests = failedTestsMeta(update.failedTests)
  return update.ok
    ? { words: `Finished ${what} in ${took}${tests}`, mark: 'done', details: [], ...call }
    : {
        words: `Failed ${what} after ${took}${tests}`,
        mark: 'failed',
        details: update.error ? [update.error] : [],
        ...call
      }
}
