import type { Role } from '@attalabs/aeg-core'

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
