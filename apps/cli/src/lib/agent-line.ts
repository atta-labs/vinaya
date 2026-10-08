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

export function formatAgentLine(
  role: Role | string,
  words: string,
  options: { mark?: AgentLineMark; now?: Date; unicode?: boolean; log?: boolean } = {}
): string {
  const now = options.now ?? new Date()
  const time = options.log ? now.toISOString() : now.toLocaleTimeString('en-GB', { hour12: false })
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
  if (update.type === 'action') {
    if (update.kind === 'message') return { words: actionVerbs.message, mark: 'working', details: [update.subject] }
    if (update.kind === 'working')
      return { words: `${actionVerbs.working}: ${update.subject}`, mark: 'working', details: [] }
    return {
      words: `${actionVerbs[update.kind]} ${update.subject}${actionMeta(update)}`,
      mark: 'working',
      details: []
    }
  }
  const took = formatDuration(update.durationMs)
  const what = `${resultVerbs[update.kind]} ${update.subject}`
  return update.ok
    ? { words: `Finished ${what} in ${took}`, mark: 'done', details: [] }
    : { words: `Failed ${what} after ${took}`, mark: 'failed', details: update.error ? [update.error] : [] }
}
