import { createHash } from 'node:crypto'
import { ROLE_VALUES, type Header, type Host, type Role, type Subject } from './schema'

function isRole(value: string | undefined): value is Role {
  return value !== undefined && (ROLE_VALUES as readonly string[]).includes(value)
}

/** `VINAYA_TASK` parses to `subject.issue`; anything not a plain integer is `null` — never invented. */
function issueFromTask(task: string | undefined): number | null {
  if (task === undefined) return null
  const n = Number(task)
  return Number.isInteger(n) ? n : null
}

function roundFromEnv(round: string | undefined): number | undefined {
  if (round === undefined) return undefined
  const n = Number(round)
  return Number.isInteger(n) ? n : undefined
}

/** Every value `buildHeader` needs, already read by the caller (the sink). Pure — no I/O here. */
export type HeaderInput = {
  now: Date
  runId: string
  seq: number
  repo: string | null
  vinaya: string
  doctrine: string
  host: Host
  hostname: string
  env: { role?: string; task?: string; round?: string }
  subject?: Partial<Subject>
}

/**
 * Builds the header (`meta` + `subject`) from values already read by the
 * caller. No filesystem, network, or process access here — the purity
 * boundary (`apps/cli/specs/surface.md` "The rule"). `subject.role` and
 * `subject.issue` come only from `input.env`/`input.subject`, never
 * self-declared by whatever's building the rest of the event.
 */
export function buildHeader(input: HeaderInput): Header {
  const role: Subject['role'] = isRole(input.env.role) ? input.env.role : 'unattributed'
  const round = roundFromEnv(input.env.round)
  const subject: Subject = {
    issue: issueFromTask(input.env.task),
    role,
    ...(round !== undefined ? { round } : {}),
    ...(input.subject ?? {})
  }
  return {
    meta: {
      schema: 1,
      ts: input.now.toISOString(),
      run_id: input.runId,
      seq: input.seq,
      repo: input.repo,
      vinaya: input.vinaya,
      doctrine: input.doctrine,
      host: input.host,
      machine: createHash('sha256').update(input.hostname).digest('hex')
    },
    subject
  }
}
