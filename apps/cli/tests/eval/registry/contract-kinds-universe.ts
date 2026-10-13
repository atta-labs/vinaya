// The universes of the contract-kinds shard, derived from the repository
// sources that state them — never listed here. Roles, the reviewers' planned
// tool, the write tools and the workflow gates are parsed from the
// capabilities-and-contracts specification; the Developer's and the
// Operator's tools come from their typed name lists; the adapters from the
// capability matrix's data; the isolation boundaries from the isolation
// specification's boundary table; the controller's own publications from the
// evaluation program's §6.12 and §6.13. Where two sources state one universe,
// the derivation refuses unless they agree.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TASK_TOOL_NAMES } from '@attalabs/aeg-core'
import { DEV_TOOL_NAMES } from '../../../src/lib/task-tools/dev-tools-server'
import type { ComponentKind } from '../../../src/lib/dev-review-eval/registry'
import { OPERATOR_EXIT_EXCLUSIONS } from '../../../src/lib/dev-review-eval/exit-check'

export const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..', '..')

export const CONTRACTS_DOC = 'apps/cli/specs/dev-review-capabilities-contracts.md'
export const ISOLATION_DOC = 'apps/cli/specs/isolation.md'
export const PROGRAM_DOC = 'apps/cli/specs/dev-review-evaluation-program.md'
export const MATRIX_DOC = 'apps/cli/specs/dev-review-engine-capability-matrix.md'
const MATRIX_DATA = 'apps/cli/tests/fixtures/dev-review-engine-capability-matrix.json'

/** The kinds this shard covers: those stated in the contract specifications and typed tool lists. */
export const CONTRACT_KINDS = ['role', 'tool', 'effect', 'adapter', 'isolation-boundary', 'gate'] as const
export type ContractKind = (typeof CONTRACT_KINDS)[number] & ComponentKind

/** Where a universe member is stated: a repository document and a heading in it. */
export interface MemberSource {
  document: string
  section: string
}

export interface UniverseMember {
  name: string
  source: MemberSource
}

/** Shrink-only checks temporarily owned by the Operator project. */
export const CONTRACT_UNIVERSE_EXCLUSIONS = OPERATOR_EXIT_EXCLUSIONS.filter((entry) => entry.kind === 'check')

/** The text and typed lists the universes are derived from; a test may substitute any of them. */
export interface ContractSources {
  contracts: string
  isolation: string
  program: string
  devTools: readonly string[]
  taskTools: readonly string[]
  adapters: readonly string[]
}

export function readContractSources(root = REPO_ROOT): ContractSources {
  const read = (path: string) => readFileSync(join(root, path), 'utf8')
  const matrix = JSON.parse(read(MATRIX_DATA)) as { adapters: string[] }
  return {
    contracts: read(CONTRACTS_DOC),
    isolation: read(ISOLATION_DOC),
    program: read(PROGRAM_DOC),
    devTools: DEV_TOOL_NAMES,
    taskTools: TASK_TOOL_NAMES,
    adapters: matrix.adapters
  }
}

// ── Markdown reading ────────────────────────────────────────────────────────

/** The body under the heading whose text starts with `prefix`, up to the next heading of the same or a higher level. */
export function sectionBody(markdown: string, prefix: string): { heading: string; body: string } {
  const lines = markdown.split('\n')
  const start = lines.findIndex((line) => /^#+ /.test(line) && line.replace(/^#+ /, '').startsWith(prefix))
  if (start === -1) throw new Error(`no heading starting "${prefix}"`)
  const level = (/^#+/.exec(lines[start] as string) as RegExpExecArray)[0].length
  const end = lines.findIndex((line, index) => {
    if (index <= start) return false
    const match = /^(#+) /.exec(line)
    return match !== null && (match[1] as string).length <= level
  })
  return {
    heading: (lines[start] as string).replace(/^#+ /, ''),
    body: lines.slice(start + 1, end === -1 ? undefined : end).join('\n')
  }
}

/** The data rows of the first pipe table in `body`, each as its trimmed cells. */
export function tableRows(body: string): string[][] {
  const rows = body
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .map((line) =>
      line
        .slice(1, line.endsWith('|') ? -1 : undefined)
        .split('|')
        .map((cell) => cell.trim())
    )
  if (rows.length < 2) throw new Error('no table found')
  return rows.slice(2)
}

/** `Code reviewer` → `code-reviewer`; markup and any parenthetical dropped. */
export function slug(text: string): string {
  return text
    .replace(/\*\*/g, '')
    .replace(/\([^)]*\)/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function sameSet(label: string, left: readonly string[], right: readonly string[]): void {
  const a = [...left].sort()
  const b = [...right].sort()
  if (a.length !== b.length || a.some((value, index) => value !== b[index])) {
    throw new Error(`${label} disagree: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`)
  }
}

function unique(label: string, members: UniverseMember[]): UniverseMember[] {
  const names = members.map((m) => m.name)
  const repeated = names.find((name, index) => names.indexOf(name) !== index)
  if (repeated !== undefined) throw new Error(`${label} names ${repeated} twice`)
  return members
}

// ── The universes ───────────────────────────────────────────────────────────

/** The controller's own publications, and the evaluation program sections that name them. */
const CONTROLLER_PUBLICATIONS = [
  { name: 'publish_ready_for_merge', section: '6.12 ', mention: '`publish_ready_for_merge`' },
  { name: 'beyond-surface-record', section: '6.13 ', mention: '**Beyond-Surface record' }
] as const

/**
 * Derives every universe this shard covers. Throws when a source no longer
 * states what it is read for, or when two sources disagree on a member.
 */
export function deriveContractUniverses(sources: ContractSources): Record<ContractKind, UniverseMember[]> {
  const grants = sectionBody(sources.contracts, '3. ')
  const liveTools = sectionBody(sources.contracts, '4.1 ')
  const toolContracts = sectionBody(sources.contracts, '4.0 ')
  const plannedTool = sectionBody(sources.contracts, '4.2 ')
  const gates = sectionBody(sources.contracts, '7. ')
  const boundaries = sectionBody(sources.isolation, '1. The six boundaries')
  const operator = sectionBody(sources.program, '6.23 ')
  const at = (document: string, section: { heading: string }): MemberSource => ({
    document,
    section: section.heading
  })

  // Roles: the first column of §3's grant table.
  const grantRows = tableRows(grants.body)
  const roles = grantRows.map((row) => ({ name: slug(row[0] as string), source: at(CONTRACTS_DOC, grants) }))

  // Developer tools: §4.1's table, which must name exactly `DEV_TOOL_NAMES`.
  const toolRows = tableRows(liveTools.body).map((row) => ({
    name: (row[0] as string).replace(/`/g, ''),
    access: row[2] as string
  }))
  sameSet(
    'the §4.1 tool table and DEV_TOOL_NAMES',
    toolRows.map((r) => r.name),
    sources.devTools
  )
  const developerGrant = grantRows.find((row) => slug(row[0] as string) === 'developer')?.[1] ?? ''
  const developerCount = /The (\w+) tools in §4\.1/.exec(developerGrant)?.[1]
  if (developerCount !== numberWord(sources.devTools.length)) {
    throw new Error(`§3 grants the Developer "${developerGrant}", but DEV_TOOL_NAMES has ${sources.devTools.length}`)
  }

  // The reviewers' planned tool: the call §4.2 names, granted in §3 as planned.
  const planned = /`(\w+)\(/.exec(plannedTool.body)?.[1]
  if (planned === undefined) throw new Error('§4.2 names no planned tool')
  for (const reviewer of ['code-reviewer', 'security-reviewer']) {
    const grant = grantRows.find((row) => slug(row[0] as string) === reviewer)?.[1] ?? ''
    if (!grant.includes(`\`${planned}\``) || !grant.includes('planned')) {
      throw new Error(`§3 does not grant ${reviewer} the planned ${planned}`)
    }
  }

  // Operator tools: `TASK_TOOL_NAMES` — the five run-control tools §3 grants and the pull-request read §6.23 adds.
  const operatorGrant = grantRows.find((row) => slug(row[0] as string) === 'operator')?.[1] ?? ''
  const operatorCount = /The (\w+) Operator tools/.exec(operatorGrant)?.[1]
  const prRead = sources.taskTools.filter((name) => name.includes('_pr_'))
  if (operatorCount !== numberWord(sources.taskTools.length - prRead.length) || prRead.length !== 1) {
    throw new Error(`§3 grants the Operator "${operatorGrant}"; TASK_TOOL_NAMES is ${sources.taskTools.join(', ')}`)
  }
  const legacyOperatorWording = 'supporting pull-request read'
  const operatorWordingCheck = 'program-6.23-supporting-pull-request-read'
  const operatorWordingExcluded = CONTRACT_UNIVERSE_EXCLUSIONS.some((entry) => entry.name === operatorWordingCheck)
  if (operator.body.includes(legacyOperatorWording)) {
    if (operatorWordingExcluded) {
      throw new Error(`the ${operatorWordingCheck} exclusion is covered and must be removed`)
    }
  } else if (!operatorWordingExcluded) {
    throw new Error('§6.23 names no supporting pull-request read and its exclusion is absent')
  }

  const tools = [
    ...tableRows(toolContracts.body).map((row) => ({
      name: (row[0] as string).replace(/`/g, ''),
      source: at(CONTRACTS_DOC, toolContracts)
    })),
    ...sources.devTools.map((name) => ({ name, source: at(CONTRACTS_DOC, liveTools) })),
    { name: planned, source: at(CONTRACTS_DOC, plannedTool) },
    ...sources.taskTools.map((name) => ({ name, source: at(PROGRAM_DOC, operator) }))
  ]

  // Effects: each §4.1 write tool, and each controller publication §6.12 and §6.13 name.
  const writes = toolRows.filter((row) => row.access.startsWith('Write'))
  if (writes.length === 0) throw new Error('§4.1 marks no tool as a write')
  const publications = CONTROLLER_PUBLICATIONS.map((publication) => {
    const section = sectionBody(sources.program, publication.section)
    if (!`${section.heading}\n${section.body}`.includes(publication.mention)) {
      throw new Error(`§${publication.section.trim()} no longer names ${publication.mention}`)
    }
    return { name: publication.name, source: at(PROGRAM_DOC, section) }
  })
  const effects = [...writes.map((row) => ({ name: row.name, source: at(CONTRACTS_DOC, liveTools) })), ...publications]

  // Adapters: the capability matrix's adapters, which its prose names as today's.
  const matrix = { heading: 'One core contract for every adapter' }
  const adapters = sources.adapters.map((name) => ({ name, source: at(MATRIX_DOC, matrix) }))

  // Isolation boundaries: the first column of §1's boundary table, which must hold six.
  const boundaryRows = tableRows(boundaries.body)
  if (boundaryRows.length !== 6)
    throw new Error(`the isolation boundary table has ${boundaryRows.length} rows, not six`)
  const isolation = boundaryRows.map((row) => ({ name: slug(row[0] as string), source: at(ISOLATION_DOC, boundaries) }))

  // Workflow gates: §7's list, after its colon, split on semicolons.
  const list = /: ([^\n]+)\.\s*$/m.exec(gates.body.trim())?.[1]
  if (list === undefined) throw new Error('§7 states no gate list')
  const gateMembers = list.split(';').map((item) => ({ name: slug(item), source: at(CONTRACTS_DOC, gates) }))

  return {
    role: unique('§3', roles),
    tool: unique('the tool sources', tools),
    effect: unique('the effect sources', effects),
    adapter: unique('the capability matrix', adapters),
    'isolation-boundary': unique('the isolation table', isolation),
    gate: unique('§7', gateMembers)
  }
}

/** Each kind's universe as the names `checkShardCompleteness` compares against. */
export function universeNames(
  universes: Record<ContractKind, UniverseMember[]>
): Record<ContractKind, readonly string[]> {
  const names = {} as Record<ContractKind, readonly string[]>
  for (const kind of CONTRACT_KINDS) names[kind] = universes[kind].map((m) => m.name)
  return names
}

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']

function numberWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n)
}
